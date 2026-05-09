import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import axios from 'axios';
import { Play, Pause, SkipForward, Search, Users, Copy, CheckCircle2, Music, ListMusic, MessageCircle, Send, X } from 'lucide-react';

const SOCKET_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

// Pre-computed stable EQ bar configs — defined outside component so Math.random never re-runs
const EQ_BARS = Array.from({ length: 32 }, (_, i) => ({
  height: Math.round(10 + Math.abs(Math.sin(i * 0.65)) * 26),   // 10–36px tall
  delay: `${((i * 137) % 900) / 1000}s`,                         // golden-ratio spread
  duration: `${0.45 + (i % 7) * 0.07}s`,                         // 0.45–0.92s cycle
}));

// Sidebar section label style
const LABEL = { color:'rgba(255,255,255,0.4)', fontSize:'10px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'2px', marginBottom:'10px' };



export default function Room() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const socketRef = useRef(null);

  const [queue, setQueue] = useState([]);
  const [currentTrack, setCurrentTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [userCount, setUserCount] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [hoveredTrack, setHoveredTrack] = useState(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [activeTab, setActiveTab] = useState('queue');
  const [lyrics, setLyrics] = useState([]);
  const [activeLine, setActiveLine] = useState(0);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [dominantColor, setDominantColor] = useState('29,185,84');
  const lyricsContainerRef = useRef(null);
  // ── Chat state
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const [chatNotif, setChatNotif] = useState(null);
  const [notifLeaving, setNotifLeaving] = useState(false);
  const [unread, setUnread] = useState(0);
  const chatEndRef = useRef(null);
  const notifTimer = useRef(null);
  const myUsername = useRef('Jammer' + Math.floor(Math.random() * 9000 + 1000));
  // ── Reactions & fun state
  const [reactions, setReactions] = useState([]);      // floating emoji particles
  const [showConfetti, setShowConfetti] = useState(false);
  const [pendingTrack, setPendingTrack] = useState(null);  // track waiting for dedication
  const [dedicationText, setDedicationText] = useState('');

  const playerRef = useRef(null);
  const isPlayerReadyRef = useRef(false);   // true once onReady fires
  const pendingVideoRef = useRef(null);     // stores videoId to play if player not ready yet
  const progressIntervalRef = useRef(null);
  const hasInteractedRef = useRef(false);

  // Keep ref in sync with state for use inside closures
  useEffect(() => { hasInteractedRef.current = hasInteracted; }, [hasInteracted]);

  // Responsive: track window width
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Debounced dynamic search — fires 400ms after user stops typing
  useEffect(() => {
    if (!searchTerm.trim()) { setSearchResults([]); return; }
    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await axios.get(`${SOCKET_URL}/api/search?q=${encodeURIComponent(searchTerm)}`);
        setSearchResults(res.data);
      } catch { setSearchResults([]); }
      setIsSearching(false);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Parse LRC synced lyrics format into [{time, text}]
  const parseLRC = (lrc) => {
    if (!lrc) return [];
    return lrc.split('\n')
      .map(line => {
        const m = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
        if (!m) return null;
        const time = parseInt(m[1]) * 60 + parseInt(m[2]) + parseInt(m[3]) / 1000;
        return { time, text: m[4].trim() };
      })
      .filter(l => l && l.text);
  };

  // Fetch lyrics from lrclib.net (free, no API key)
  useEffect(() => {
    if (!currentTrack?.name) { setLyrics([]); return; }
    setLyricsLoading(true);
    setLyrics([]);
    setActiveLine(0);
    const params = new URLSearchParams({
      artist_name: currentTrack.artist || '',
      track_name:  currentTrack.name  || '',
    });
    fetch(`https://lrclib.net/api/search?${params}`)
      .then(r => r.json())
      .then(data => {
        const hit = data?.[0];
        if (hit?.syncedLyrics) {
          setLyrics(parseLRC(hit.syncedLyrics));
        } else if (hit?.plainLyrics) {
          setLyrics(hit.plainLyrics.split('\n').filter(Boolean).map((text, i) => ({ time: i, text })));
        } else {
          setLyrics([]);
        }
      })
      .catch(() => setLyrics([]))
      .finally(() => setLyricsLoading(false));
  }, [currentTrack?.name, currentTrack?.artist]);

  // Track active lyric line based on playback position
  useEffect(() => {
    if (!lyrics.length) return;
    let idx = 0;
    for (let i = 0; i < lyrics.length; i++) {
      if (lyrics[i].time <= progress) idx = i;
      else break;
    }
    setActiveLine(idx);
    // Auto-scroll the active line into view
    const container = lyricsContainerRef.current;
    if (container) {
      const activeEl = container.querySelector('.lyric-active');
      if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [progress, lyrics]);

  // Extract dominant color from album art using Canvas
  useEffect(() => {
    if (!currentTrack?.albumArt) { setDominantColor('29,185,84'); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 4; canvas.height = 4;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 4, 4);
        const d = ctx.getImageData(0, 0, 4, 4).data;
        // Average the 4x4 pixels for a stable dominant color
        let r=0,g=0,b=0;
        for (let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2];}
        const n=d.length/4;
        setDominantColor(`${Math.round(r/n)},${Math.round(g/n)},${Math.round(b/n)}`);
      } catch { setDominantColor('29,185,84'); }
    };
    img.onerror = () => setDominantColor('29,185,84');
    img.src = currentTrack.albumArt;
  }, [currentTrack?.albumArt]);


  const loadAndPlay = useCallback((videoId) => {
    if (!videoId) return;
    if (isPlayerReadyRef.current && playerRef.current?.loadVideoById) {
      console.log('🎵 Loading video:', videoId);
      playerRef.current.loadVideoById(videoId);  // loadVideoById auto-plays
    } else {
      console.log('⏳ Player not ready, queuing video:', videoId);
      pendingVideoRef.current = videoId;          // play it once onReady fires
    }
  }, []);

  // ─── YouTube Player Setup ─────────────────────────────────────────────────
  const initYTPlayer = useCallback(() => {
    if (playerRef.current || !window.YT || !window.YT.Player) return;
    console.log('🔧 Initializing YouTube player...');
    playerRef.current = new window.YT.Player('yt-player-container', {
      height: '300',
      width: '300',
      playerVars: { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1 },
      events: {
        onReady: () => {
          console.log('✅ YouTube player ready!');
          isPlayerReadyRef.current = true;
          // If a video was queued before the player was ready, play it now
          if (pendingVideoRef.current && hasInteractedRef.current) {
            console.log('▶ Playing pending video:', pendingVideoRef.current);
            playerRef.current.loadVideoById(pendingVideoRef.current);
            pendingVideoRef.current = null;
          }
        },
        onStateChange: (evt) => {
          if (evt.data === window.YT.PlayerState.ENDED) {
            socketRef.current?.emit('skip', roomId);
          }
          if (evt.data === window.YT.PlayerState.PLAYING) {
            // Only update duration, do NOT call setIsPlaying here.
            // State is managed exclusively by socket events to avoid feedback loops.
            setDuration(playerRef.current.getDuration?.() || 0);
          }
        }
      }
    });
  }, [roomId]);

  // Load YT IFrame API once
  useEffect(() => {
    if (window.YT && window.YT.Player) {
      initYTPlayer();
    } else {
      const existing = document.getElementById('yt-api-script');
      if (!existing) {
        const tag = document.createElement('script');
        tag.id = 'yt-api-script';
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
      }
      window.onYouTubeIframeAPIReady = initYTPlayer;
    }
  }, [initYTPlayer]);

  // ─── Socket.IO Setup ──────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io(SOCKET_URL, { reconnection: true });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join-room', { roomId });
    });

    socket.on('error', (err) => {
      alert(err.message);
      navigate('/');
    });

    socket.on('sync-state', (state) => {
      setQueue(state.queue || []);
      setCurrentTrack(state.currentTrack);
      setIsPlaying(state.isPlaying);
      if (state.currentTrack?.youtubeId && hasInteractedRef.current) {
        if (isPlayerReadyRef.current && playerRef.current?.loadVideoById) {
          playerRef.current.loadVideoById({ videoId: state.currentTrack.youtubeId, startSeconds: state.currentTime || 0 });
          if (!state.isPlaying) setTimeout(() => playerRef.current?.pauseVideo(), 500);
        }
      }
    });

    socket.on('user-joined', ({ count }) => setUserCount(count));
    socket.on('user-left', ({ count }) => setUserCount(count));
    socket.on('update-queue', setQueue);

    socket.on('track-changed', (track) => {
      console.log('🎶 Track changed:', track?.name);
      setCurrentTrack(track);
      setProgress(0);
      setDuration(0);
      setIsPlaying(!!track);
      if (track?.youtubeId && hasInteractedRef.current) {
        loadAndPlay(track.youtubeId);
      }
      // 🎊 Confetti burst on every new song
      if (track) {
        setShowConfetti(true);
        setTimeout(() => setShowConfetti(false), 3500);
      }
    });

    socket.on('play', () => {
      setIsPlaying(true);
      // Always try to play — the server is the source of truth
      if (isPlayerReadyRef.current && playerRef.current) {
        const state = playerRef.current.getPlayerState?.();
        if (state === -1 && currentTrack?.youtubeId) {
          // Player has no video loaded yet, load it
          playerRef.current.loadVideoById(currentTrack.youtubeId);
        } else {
          playerRef.current.playVideo?.();
        }
      }
    });

    socket.on('pause', () => {
      setIsPlaying(false);
      // Always pause — no hasInteracted guard, server is source of truth
      if (isPlayerReadyRef.current && playerRef.current) {
        playerRef.current.pauseVideo?.();
      }
    });

    socket.on('seek', (time) => {
      setProgress(time);
      if (isPlayerReadyRef.current && playerRef.current?.seekTo && hasInteractedRef.current) {
        playerRef.current.seekTo(time, true);
      }
    });

    socket.on('reaction', ({ emoji, id }) => {
      const x = 8 + Math.random() * 84;   // random horizontal position
      setReactions(prev => [...prev, { emoji, id, x }]);
      setTimeout(() => setReactions(prev => prev.filter(r => r.id !== id)), 3000);
    });

    socket.on('chat-message', (msg) => {
      setMessages(prev => [...prev, msg]);
      // Scroll chat to bottom
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      // Show popup if chat panel not open / not on chat tab
      const isChatVisible = chatOpen || activeTab === 'chat';
      if (!isChatVisible) {
        setUnread(n => n + 1);
        // Clear old timer
        clearTimeout(notifTimer.current);
        setNotifLeaving(false);
        setChatNotif(msg);
        notifTimer.current = setTimeout(() => {
          setNotifLeaving(true);
          setTimeout(() => setChatNotif(null), 300);
        }, 4000);
      }
    });

    return () => {
      socket.disconnect();
      clearInterval(progressIntervalRef.current);
      clearTimeout(notifTimer.current);
    };
  }, [roomId, navigate, loadAndPlay]);

  // Send a chat message
  const sendMessage = () => {
    const text = chatInput.trim();
    if (!text || !socketRef.current) return;
    socketRef.current.emit('chat-message', { roomId, message: text, user: myUsername.current });
    setChatInput('');
  };

  const dismissNotif = () => {
    clearTimeout(notifTimer.current);
    setNotifLeaving(true);
    setTimeout(() => setChatNotif(null), 300);
  };

  const openChat = () => {
    setChatOpen(true);
    setUnread(0);
    setChatNotif(null);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'instant' }), 80);
  };

  // Send an emoji reaction to all users
  const sendReaction = (emoji) => {
    socketRef.current?.emit('reaction', { roomId, emoji });
  };

  // Submit a track with an optional dedication note
  const submitWithDedication = () => {
    if (!pendingTrack) return;
    // Add the track to the queue
    socketRef.current?.emit('add-track', { roomId, track: pendingTrack });
    // If there's a dedication message, send it as a special system chat message
    if (dedicationText.trim()) {
      const sysMsg = {
        id: `sys-${Date.now()}`,
        message: dedicationText.trim(),
        user: myUsername.current,
        senderId: 'system',
        timestamp: Date.now(),
        isDedication: true,
        trackName: pendingTrack.name,
      };
      socketRef.current?.emit('chat-message', {
        roomId,
        message: `🎵 "${pendingTrack.name}" — ${dedicationText.trim()} 💕`,
        user: myUsername.current,
        isDedication: true,
      });
    }
    // Reset
    setPendingTrack(null);
    setDedicationText('');
    if (isMobile) setActiveTab('queue');
  };


  useEffect(() => {
    clearInterval(progressIntervalRef.current);
    if (isPlaying && hasInteracted) {
      progressIntervalRef.current = setInterval(() => {
        if (isPlayerReadyRef.current && playerRef.current?.getCurrentTime) {
          const t = playerRef.current.getCurrentTime();
          const d = playerRef.current.getDuration?.() || 0;
          setProgress(t);
          setDuration(d);
          socketRef.current?.emit('sync-time', { roomId, time: t });
        }
      }, 1000);
    }
    return () => clearInterval(progressIntervalRef.current);
  }, [isPlaying, hasInteracted, roomId]);

  // ─── Handlers ─────────────────────────────────────────────────────────────
  const handleEnterRoom = () => {
    setHasInteracted(true);
    hasInteractedRef.current = true;
    // If a track is already loaded (e.g. user joined mid-session), play it now
    if (currentTrack?.youtubeId) {
      loadAndPlay(currentTrack.youtubeId);
    }
    // If there's a pending video that was queued before user interacted, play it
    if (pendingVideoRef.current && isPlayerReadyRef.current && playerRef.current?.loadVideoById) {
      playerRef.current.loadVideoById(pendingVideoRef.current);
      pendingVideoRef.current = null;
    }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchTerm.trim()) return;
    setIsSearching(true);
    try {
      const res = await axios.get(`${SOCKET_URL}/api/search?q=${encodeURIComponent(searchTerm)}`);
      setSearchResults(res.data);
    } catch (err) {
      console.error(err);
      alert('Search failed. Is the backend running?');
    }
    setIsSearching(false);
  };


  const handleAddTrack = (track) => {
    // Open dedication modal — user can add a love note with the song
    setPendingTrack(track);
    setDedicationText('');
    setSearchTerm('');
    setSearchResults([]);
  };

  const togglePlay = () => {
    if (!currentTrack) return;
    // Only emit to server — the server broadcasts back to ALL users (including us)
    // The socket 'play'/'pause' handler then controls the actual player
    if (isPlaying) {
      socketRef.current?.emit('pause', roomId);
    } else {
      socketRef.current?.emit('play', roomId);
    }
  };

  const handleSkip = () => {
    socketRef.current?.emit('skip', roomId);
  };

  const copyRoomCode = () => {
    navigator.clipboard.writeText(roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatTime = (s) => {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  };

  const progressPct = duration > 0 ? (progress / duration) * 100 : 0;
  const dc = dominantColor; // shorthand

  // ─── Hero visual ────────────────────────────────────────────────────────────
  const heroJSX = currentTrack ? (
    <div style={{ position:'relative', overflow:'hidden', flexShrink:0, height:'300px', display:'flex', alignItems:'center', justifyContent:'center' }}>
      {/* Full blurred album art backdrop */}
      <div style={{ position:'absolute', inset:'-20px', backgroundImage:`url(${currentTrack.albumArt})`, backgroundSize:'cover', backgroundPosition:'center', filter:'blur(70px) saturate(3) brightness(0.45)', zIndex:0 }} />
      {/* Color gradient overlay */}
      <div style={{ position:'absolute', inset:0, background:`linear-gradient(135deg, rgba(${dc},0.08) 0%, rgba(0,0,0,0.7) 100%)`, zIndex:1 }} />
      {/* Bottom fade to #060612 */}
      <div style={{ position:'absolute', bottom:0, left:0, right:0, height:'80px', background:'linear-gradient(to bottom, transparent, #060612)', zIndex:2 }} />
      {/* Floating aura orbs */}
      {isPlaying && [0,1,2].map(i => (
        <div key={i} className="aura" style={{ width:`${100+i*70}px`, height:`${100+i*70}px`, top:`${5+i*30}%`, left:`${10+i*30}%`, opacity:0.12, animationDelay:`${i*1.2}s`, background:`radial-gradient(circle, rgba(${dc},1) 0%, transparent 70%)`, zIndex:1 }} />
      ))}
      {/* Content row */}
      <div style={{ position:'relative', zIndex:3, display:'flex', alignItems:'center', gap:'32px', padding:'0 40px', width:'100%' }}>
        {/* Vinyl with concentric rings */}
        <div style={{ flexShrink:0, position:'relative', width:'180px', height:'180px', display:'flex', alignItems:'center', justifyContent:'center' }}>
          {/* Rings */}
          {isPlaying && [0,1,2].map(i => (
            <div key={i} className="ring" style={{ width:'180px', height:'180px', '--ring-color':`rgba(${dc},0.5)`, animationDelay:`${i*0.8}s`, position:'absolute' }} />
          ))}
          <img
            src={currentTrack.albumArt}
            className={isPlaying ? 'vinyl-spinning' : 'vinyl-paused'}
            style={{ width:'160px', height:'160px', borderRadius:'50%', objectFit:'cover', display:'block', boxShadow:`0 0 40px rgba(${dc},0.5), 0 20px 60px rgba(0,0,0,0.8)`, '--glow-color':`rgba(${dc},0.5)` }}
            alt=""
          />
        </div>
        {/* Info + waveform */}
        <div style={{ flex:1, minWidth:0 }}>
          <p style={{ fontSize:'10px', fontWeight:'700', letterSpacing:'4px', textTransform:'uppercase', color:`rgba(${dc},1)`, marginBottom:'10px' }}>
            ◆ Now Playing ◆
          </p>
          <h2 style={{ fontSize:'30px', fontWeight:'900', lineHeight:'1.15', marginBottom:'6px', textShadow:`0 0 40px rgba(${dc},0.8)`, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {currentTrack.name}
          </h2>
          <p style={{ fontSize:'15px', color:'rgba(255,255,255,0.55)', marginBottom:'24px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {currentTrack.artist}
          </p>
          {/* Proper EQ bars using pre-computed EQ_BARS */}
          <div style={{ display:'flex', alignItems:'flex-end', gap:'2px', height:'44px' }}>
            {EQ_BARS.map((bar, i) => (
              <div
                key={i}
                className={`eq-bar${isPlaying ? '' : ' eq-bar-paused'}`}
                style={{
                  flex:1,
                  height:`${bar.height}px`,
                  background:`rgba(${dc},${0.6 + (i%3)*0.13})`,
                  animationDelay: bar.delay,
                  animationDuration: bar.duration,
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  ) : (
    <div style={{ flexShrink:0, height:'220px', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:'14px', position:'relative', overflow:'hidden' }}>
      <div style={{ position:'absolute', inset:0, background:'radial-gradient(ellipse at 50% 120%, rgba(29,185,84,0.08) 0%, transparent 65%)' }} />
      <div style={{ fontSize:'60px', filter:'drop-shadow(0 0 24px rgba(29,185,84,0.4))', animation:'aura-pulse 3s ease-in-out infinite' }}>🎵</div>
      <p style={{ fontWeight:'800', fontSize:'18px', color:'white' }}>Start the Jam!</p>
      <p style={{ fontSize:'13px', color:'rgba(255,255,255,0.4)' }}>Search for a song and let it rip 🔥</p>
    </div>
  );

  // ── Pre-computed confetti pieces (stable, no random in render)
  const CONFETTI_COLORS = ['#1DB954','#ff6496','#ffd700','#00d4ff','#ff8c00','#c084fc','#f472b6','#34d399'];
  const CONFETTI_PIECES = Array.from({length:22}, (_,i) => ({
    left: `${(i * 4.5) % 100}%`,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    dur: `${2 + (i % 5) * 0.4}s`,
    delay: `${(i * 0.12) % 1.2}s`,
  }));

  // ── 🎊 Confetti burst
  const confettiJSX = showConfetti ? (
    <>
      {CONFETTI_PIECES.map((p, i) => (
        <div key={i} className="confetti-piece" style={{ left:p.left, background:p.color, '--dur':p.dur, '--delay':p.delay }} />
      ))}
    </>
  ) : null;

  // ── 🎭 Floating reaction particles
  const reactionParticlesJSX = reactions.map(r => (
    <div key={r.id} className="reaction-particle" style={{ left:`${r.x}%` }}>{r.emoji}</div>
  ));

  // ── 🎭 Reaction bar — floating pill of emoji buttons
  const EMOJIS = ['❤️','🔥','😍','🎵','✨','💫','😂','🎉','👏','💕'];
  const reactionBarJSX = hasInteracted ? (
    <div style={{
      position:'fixed', right:'16px', bottom:'106px', zIndex:200,
      display:'flex', flexDirection:'column', gap:'6px', alignItems:'center',
    }}>
      <div style={{
        background:'rgba(10,10,25,0.75)', backdropFilter:'blur(16px)',
        border:'1px solid rgba(255,255,255,0.1)', borderRadius:'30px',
        padding:'8px 6px', display:'flex', flexDirection:'column', gap:'4px',
        boxShadow:'0 8px 32px rgba(0,0,0,0.5)',
      }}>
        {EMOJIS.map(e => (
          <button key={e} className="react-btn" onClick={() => sendReaction(e)} title={`React with ${e}`}>{e}</button>
        ))}
      </div>
    </div>
  ) : null;

  // ── 💕 Vibing Together badge (when 2 people in room)
  const vibeJSX = userCount === 2 ? (
    <div className="vibe-badge" style={{ marginBottom:'16px' }}>
      <span style={{ fontSize:'18px' }}>💕</span>
      <div>
        <p style={{ fontWeight:'700', fontSize:'12px', color:'rgba(255,180,200,0.9)' }}>Vibing Together</p>
        <p style={{ fontSize:'10px', color:'rgba(255,255,255,0.4)' }}>Just the two of you ✨</p>
      </div>
    </div>
  ) : null;

  // ── 🎁 Dedication Modal
  const dedicationModalJSX = pendingTrack ? (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', backdropFilter:'blur(8px)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
      <div className="dedication-modal glass" style={{ maxWidth:'400px', width:'100%', borderRadius:'20px', padding:'28px 24px', border:'1px solid rgba(255,100,150,0.25)', boxShadow:'0 24px 80px rgba(0,0,0,0.7)' }}>
        {/* Track info */}
        <div style={{ display:'flex', alignItems:'center', gap:'14px', marginBottom:'20px' }}>
          <img src={pendingTrack.album?.images?.[1]?.url || ''} style={{ width:'56px', height:'56px', borderRadius:'10px', objectFit:'cover', background:'#333', flexShrink:0 }} alt="" />
          <div style={{ minWidth:0 }}>
            <p style={{ fontWeight:'800', fontSize:'15px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{pendingTrack.name}</p>
            <p style={{ color:'rgba(255,255,255,0.45)', fontSize:'13px' }}>{pendingTrack.artists?.[0]?.name}</p>
          </div>
        </div>
        <p style={{ fontSize:'13px', color:'rgba(255,255,255,0.5)', marginBottom:'14px', textAlign:'center' }}>Add a little dedication? 💌</p>
        <input
          className="chat-input"
          style={{ width:'100%', marginBottom:'16px', borderColor:'rgba(255,100,150,0.3)' }}
          placeholder="e.g. this one reminds me of you 💕"
          value={dedicationText}
          onChange={e => setDedicationText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submitWithDedication()}
          autoFocus
          maxLength={120}
        />
        <div style={{ display:'flex', gap:'10px' }}>
          <button
            onClick={submitWithDedication}
            style={{ flex:1, background:'linear-gradient(135deg, #1DB954, #1ed760)', color:'black', fontWeight:'800', padding:'12px', borderRadius:'12px', border:'none', cursor:'pointer', fontSize:'14px' }}
          >
            {dedicationText.trim() ? '💕 Add with dedication' : '🎵 Add to Queue'}
          </button>
          <button
            onClick={() => { setPendingTrack(null); setDedicationText(''); }}
            style={{ padding:'12px 16px', background:'rgba(255,255,255,0.07)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:'12px', color:'rgba(255,255,255,0.5)', cursor:'pointer', fontSize:'13px' }}
          >Cancel</button>
        </div>
      </div>
    </div>
  ) : null;

  const trackListJSX = (tracks, isQueue) => tracks.map((track, i) => (


    <div
      key={track.id + (isQueue ? 'q' : '')}
      style={{ display:'flex', alignItems:'center', padding:'10px 8px', borderRadius:'6px', gap:'12px', background: hoveredTrack === track.id+(isQueue?'q':'') ? 'rgba(255,255,255,0.07)' : 'transparent' }}
      onMouseEnter={() => setHoveredTrack(track.id+(isQueue?'q':''))}
      onMouseLeave={() => setHoveredTrack(null)}
    >
      {isQueue && <span style={{ color:'#b3b3b3', width:'18px', fontSize:'13px', flexShrink:0 }}>{i+1}</span>}
      <img src={isQueue ? track.albumArt : (track.album?.images?.[2]?.url||'')} style={{ width:'42px', height:'42px', borderRadius:'4px', objectFit:'cover', flexShrink:0, background:'#333' }} alt="" onError={e=>e.currentTarget.style.background='#333'} />
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontWeight:'500', fontSize:'14px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{track.name}</div>
        <div style={{ color:'#b3b3b3', fontSize:'12px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{isQueue ? track.artist : track.artists?.[0]?.name}</div>
      </div>
      {!isQueue && (
        <button
          onClick={() => { handleAddTrack(track); if(isMobile) setActiveTab('queue'); }}
          style={{ flexShrink:0, border:'1px solid #b3b3b3', background:'transparent', color:'white', borderRadius:'50px', padding:'5px 12px', fontSize:'11px', fontWeight:'700', cursor:'pointer', opacity: isMobile ? 1 : hoveredTrack===track.id ? 1 : 0, transition:'opacity 0.15s' }}
        >ADD</button>
      )}
    </div>
  ));

  const lyricsPanelJSX = (
    <div ref={lyricsContainerRef} style={{ flex:1, overflowY:'auto', padding: isMobile ? '16px' : '16px 24px 24px', scrollBehavior:'smooth' }}>
      {!currentTrack ? (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', color:'#b3b3b3', gap:'12px' }}>
          <span style={{ fontSize:'40px' }}>🎵</span>
          <p style={{ fontWeight:'600' }}>No song playing</p>
          <p style={{ fontSize:'13px' }}>Add a song to the queue to see lyrics</p>
        </div>
      ) : lyricsLoading ? (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'60%', color:'#b3b3b3', gap:'12px' }}>
          <div style={{ width:'32px', height:'32px', border:'3px solid #333', borderTop:'3px solid #1DB954', borderRadius:'50%', animation:'vinyl-spin 0.8s linear infinite' }} />
          <p style={{ fontSize:'13px' }}>Fetching lyrics...</p>
        </div>
      ) : lyrics.length === 0 ? (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'60%', color:'#b3b3b3', gap:'12px' }}>
          <span style={{ fontSize:'36px' }}>😔</span>
          <p style={{ fontWeight:'600' }}>No lyrics found</p>
          <p style={{ fontSize:'13px' }}>for <strong style={{ color:'white' }}>{currentTrack?.name}</strong></p>
        </div>
      ) : (
        <div style={{ textAlign:'center', paddingBottom:'80px' }}>
          <p style={{ fontSize:'13px', color:'#b3b3b3', marginBottom:'32px', fontStyle:'italic' }}>{currentTrack?.name} · {currentTrack?.artist}</p>
          {lyrics.map((line, i) => (
            <p
              key={i}
              className={i === activeLine ? 'lyric-active' : ''}
              style={{
                fontSize: i === activeLine ? (isMobile ? '20px' : '24px') : (isMobile ? '16px' : '18px'),
                fontWeight: i === activeLine ? '800' : '400',
                color: i === activeLine ? '#1DB954' : i < activeLine ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.6)',
                marginBottom: '18px',
                lineHeight: '1.4',
                transition: 'all 0.4s ease',
                textShadow: i === activeLine ? '0 0 20px rgba(29,185,84,0.5)' : 'none',
                transform: i === activeLine ? 'scale(1.04)' : 'scale(1)',
                display: 'block',
                transformOrigin: 'center',
              }}
            >{line.text}</p>
          ))}
        </div>
      )}
    </div>
  );

  // ─── Chat Panel JSX ────────────────────────────────────────────────────────
  const chatPanelJSX = (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>
      {/* Chat Header */}
      <div style={{ padding:'16px 20px 12px', borderBottom:'1px solid rgba(255,255,255,0.07)', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
          <div style={{ width:'32px', height:'32px', borderRadius:'50%', background:'rgba(29,185,84,0.15)', border:'1px solid rgba(29,185,84,0.3)', display:'flex', alignItems:'center', justifyContent:'center' }}>
            <MessageCircle size={16} color="#1DB954" />
          </div>
          <div>
            <p style={{ fontWeight:'700', fontSize:'15px' }}>Live Chat</p>
            <p style={{ fontSize:'11px', color:'rgba(255,255,255,0.35)' }}>You are <span style={{ color:'#1DB954' }}>{myUsername.current}</span></p>
          </div>
        </div>
        {!isMobile && (
          <button onClick={() => setChatOpen(false)} style={{ background:'transparent', border:'none', cursor:'pointer', color:'rgba(255,255,255,0.4)', padding:'4px', borderRadius:'6px', display:'flex' }}>
            <X size={18} />
          </button>
        )}
      </div>

      {/* Messages */}
      <div style={{ flex:1, overflowY:'auto', padding:'16px', display:'flex', flexDirection:'column', gap:'10px' }}>
        {messages.length === 0 ? (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100%', gap:'12px', color:'rgba(255,255,255,0.3)' }}>
            <MessageCircle size={40} style={{ opacity:0.3 }} />
            <p style={{ fontWeight:'600', fontSize:'14px' }}>No messages yet</p>
            <p style={{ fontSize:'12px' }}>Say something to the jam! 🎵</p>
          </div>
        ) : messages.map((msg) => {
          const isMe = msg.user === myUsername.current;
          return (
            <div key={msg.id} style={{ display:'flex', flexDirection:'column', alignItems: isMe ? 'flex-end' : 'flex-start', gap:'3px' }}>
              {!isMe && (
                <span style={{ fontSize:'11px', color:'rgba(255,255,255,0.4)', paddingLeft:'4px', fontWeight:'600' }}>{msg.user}</span>
              )}
              <div className={isMe ? 'chat-bubble-mine' : 'chat-bubble-theirs'}>
                <p style={{ fontSize:'14px', lineHeight:'1.4', color: isMe ? '#e8ffe8' : 'rgba(255,255,255,0.9)' }}>{msg.message}</p>
              </div>
              <span style={{ fontSize:'10px', color:'rgba(255,255,255,0.25)', paddingLeft:'4px', paddingRight:'4px' }}>
                {new Date(msg.timestamp).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}
              </span>
            </div>
          );
        })}
        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <div style={{ padding:'12px 16px', borderTop:'1px solid rgba(255,255,255,0.07)', display:'flex', gap:'8px', alignItems:'center', flexShrink:0 }}>
        <input
          className="chat-input"
          type="text"
          value={chatInput}
          onChange={e => setChatInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && sendMessage()}
          placeholder="Say something... 🎶"
          maxLength={300}
        />
        <button className="chat-send-btn" onClick={sendMessage}>
          <Send size={16} color="black" />
        </button>
      </div>
    </div>
  );

  // ─── Chat Notification Popup ───────────────────────────────────────────────
  const notifJSX = chatNotif ? (
    <div className={`chat-notif${notifLeaving ? ' leaving' : ''}`}>
      <div style={{ width:'34px', height:'34px', borderRadius:'50%', background:'rgba(29,185,84,0.2)', border:'1px solid rgba(29,185,84,0.4)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
        <span style={{ fontSize:'14px' }}>💬</span>
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <p style={{ fontSize:'12px', fontWeight:'700', color:'#1DB954', marginBottom:'2px' }}>{chatNotif.user}</p>
        <p style={{ fontSize:'13px', color:'rgba(255,255,255,0.85)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{chatNotif.message}</p>
      </div>
      <button onClick={dismissNotif} style={{ background:'transparent', border:'none', cursor:'pointer', color:'rgba(255,255,255,0.35)', padding:'2px', display:'flex', flexShrink:0, pointerEvents:'all' }}>
        <X size={14} />
      </button>
    </div>
  ) : null;

  const searchPanelJSX = (

    <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>
      <div style={{ padding: isMobile ? '12px 16px 8px' : '20px 24px 8px', flexShrink:0 }}>
        <div style={{ position:'relative', maxWidth: isMobile ? '100%' : '480px' }}>
          <span style={{ position:'absolute', left:'16px', top:'50%', transform:'translateY(-50%)', color:'#b3b3b3', pointerEvents:'none' }}><Search size={18} /></span>
          <input
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search for songs or artists..."
            style={{ width:'100%', background:'#242424', border:'none', borderRadius:'50px', color:'white', padding:'12px 20px 12px 48px', fontSize:'14px', outline:'none', boxSizing:'border-box' }}
            onFocus={e => e.currentTarget.style.background='#333'}
            onBlur={e => e.currentTarget.style.background='#242424'}
          />
        </div>
      </div>
      <div style={{ flex:1, overflowY:'auto', padding: isMobile ? '8px 16px 16px' : '8px 24px 24px' }}>
        {isSearching && <p style={{ color:'#b3b3b3', padding:'16px 8px' }}>Searching Spotify...</p>}
        {!isSearching && searchTerm && searchResults.length === 0 && <p style={{ color:'#b3b3b3', padding:'16px 8px' }}>No results found.</p>}
        {searchResults.length > 0 && trackListJSX(searchResults, false)}
        {!searchTerm && (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'48px 24px', color:'#b3b3b3', gap:'12px' }}>
            <Search size={48} style={{ opacity:0.2 }} />
            <p style={{ fontWeight:'600' }}>Search for a song</p>
            <p style={{ fontSize:'13px' }}>Results appear as you type</p>
          </div>
        )}
      </div>
    </div>
  );

  const queuePanelJSX = (
    <div style={{ flex:1, overflowY:'auto' }}>
      {!isMobile && null}
      <div style={{ padding: isMobile ? '16px' : '16px 24px 24px' }}>
        <p style={{ fontSize: isMobile ? '18px' : '22px', fontWeight:'800', marginBottom:'16px' }}>Up Next</p>
        {queue.length === 0 ? (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'48px 24px', color:'#b3b3b3', border:'1px dashed rgba(255,255,255,0.1)', borderRadius:'12px', gap:'12px' }}>
            <ListMusic size={48} style={{ opacity:0.3 }} />
            <p style={{ fontWeight:'600' }}>Queue is empty</p>
            <p style={{ fontSize:'13px' }}>Search for a song to start the jam!</p>
          </div>
        ) : trackListJSX(queue, true)}
      </div>
    </div>
  );


  const playerBarJSX = (
    <div style={{ background:'#181818', borderTop:'1px solid #282828', padding: isMobile ? '8px 12px' : '0 16px', height: isMobile ? 'auto' : '90px', display:'flex', flexDirection: isMobile ? 'column' : 'row', alignItems:'center', justifyContent:'space-between', gap: isMobile ? '8px' : 0, flexShrink:0, position:'relative', overflow:'hidden' }}>
      {/* Background aura when playing */}
      {isPlaying && currentTrack && (
        <div className="aura" style={{ width:'300px', height:'300px', bottom:'-150px', left:'50%', transform:'translateX(-50%)' }} />
      )}
      <div style={{ display:'flex', alignItems:'center', gap:'10px', width: isMobile ? '100%' : '30%', minWidth:0, position:'relative', zIndex:1 }}>
        {currentTrack ? (
          <>
            {/* Vinyl-spinning album art */}
            <div className={isPlaying ? 'glow-playing' : ''} style={{ borderRadius:'50%', flexShrink:0, width: isMobile?'40px':'56px', height: isMobile?'40px':'56px' }}>
              <img
                src={currentTrack.albumArt}
                className={isPlaying ? 'vinyl-spinning' : 'vinyl-paused'}
                style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }}
                alt=""
              />
            </div>
            <div style={{ minWidth:0, flex:1 }}>
              <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
                <div style={{ fontWeight:'600', fontSize: isMobile ? '13px' : '14px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', color: isPlaying ? '#1DB954' : 'white', transition:'color 0.3s' }}>{currentTrack.name}</div>
                {/* Equalizer bars */}
                <div style={{ display:'flex', alignItems:'flex-end', gap:'2px', height:'20px', flexShrink:0 }}>
                  {[0,1,2,3].map(i => (
                    <div key={i} className={`eq-bar${isPlaying ? '' : ' eq-bar-paused'}`} style={{ height: i%2===0 ? '12px' : '8px' }} />
                  ))}
                </div>
              </div>
              <div style={{ color:'#b3b3b3', fontSize:'12px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{currentTrack.artist}</div>
            </div>
          </>
        ) : <div style={{ color:'#b3b3b3', fontSize:'13px' }}>Nothing playing yet</div>}
      </div>
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', width: isMobile ? '100%' : '40%', position:'relative', zIndex:1 }}>
        <div style={{ display:'flex', alignItems:'center', gap:'20px', marginBottom:'6px' }}>
          <button onClick={togglePlay} disabled={!currentTrack} style={{ width:'38px', height:'38px', borderRadius:'50%', background: isPlaying ? '#1DB954' : 'white', border:'none', cursor: currentTrack?'pointer':'not-allowed', display:'flex', alignItems:'center', justifyContent:'center', opacity: currentTrack?1:0.4, transition:'background 0.3s, transform 0.1s' }}
            onMouseEnter={e => { if(currentTrack) e.currentTarget.style.transform='scale(1.08)'; }}
            onMouseLeave={e => e.currentTarget.style.transform='scale(1)'}
          >
            {isPlaying ? <Pause size={18} fill={isPlaying?'black':'black'} color="black" /> : <Play size={18} fill="black" color="black" style={{ marginLeft:'2px' }} />}
          </button>
          <button onClick={handleSkip} disabled={!currentTrack} style={{ background:'transparent', border:'none', color:'#b3b3b3', cursor: currentTrack?'pointer':'not-allowed', display:'flex', alignItems:'center', opacity: currentTrack?1:0.4 }}>
            <SkipForward size={22} fill="currentColor" />
          </button>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:'8px', width:'100%', fontSize:'11px', color:'#b3b3b3' }}>
          <span style={{ minWidth:'32px', textAlign:'right' }}>{formatTime(progress)}</span>
          <div style={{ flex:1, height:'4px', background:'#4d4d4d', borderRadius:'4px', overflow:'hidden' }}>
            <div className={isPlaying ? 'progress-playing' : ''} style={{ height:'100%', width:`${progressPct}%`, background: isPlaying ? undefined : 'white', borderRadius:'4px', transition: isPlaying ? 'width 0.5s linear' : 'width 0.5s linear, background 0.3s' }} />
          </div>
          <span style={{ minWidth:'32px' }}>{formatTime(duration)}</span>
        </div>
      </div>
      {!isMobile && (
        <div style={{ width:'30%', display:'flex', justifyContent:'flex-end', alignItems:'center', color:'#b3b3b3', fontSize:'13px', gap:'6px', position:'relative', zIndex:1 }}>
          <Users size={16} /><span>{userCount}</span>
        </div>
      )}
    </div>
  );


  // ─── Main Room UI ─────────────────────────────────────────────────────────
  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', width:'100vw', overflow:'hidden', backgroundColor:'#060612', color:'white' }}>
      {notifJSX}
      {confettiJSX}
      {reactionParticlesJSX}
      {reactionBarJSX}
      {dedicationModalJSX}
      {/* Hidden YouTube Player */}
      <div style={{ position:'absolute', left:'-9999px', top:'-9999px', width:'300px', height:'300px', pointerEvents:'none' }}>
        <div id="yt-player-container"></div>
      </div>

      {!hasInteracted ? (
        <div className="grid-bg" style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', background:'#060612', padding:'20px' }}>
          {/* Radial glow */}
          <div style={{ position:'absolute', width:'600px', height:'600px', borderRadius:'50%', background:'radial-gradient(circle, rgba(29,185,84,0.12) 0%, transparent 70%)', pointerEvents:'none' }} />
          <div className="glass" style={{ textAlign:'center', padding:'48px 40px', borderRadius:'24px', maxWidth:'420px', width:'100%', boxShadow:'0 32px 80px rgba(0,0,0,0.7)', border:'1px solid rgba(29,185,84,0.15)', position:'relative' }}>
            <div style={{ display:'flex', justifyContent:'center', marginBottom:'28px' }}>
              <div style={{ width:'80px', height:'80px', background:'#1DB954', borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 0 50px rgba(29,185,84,0.6)', animation:'pulse-glow 2s ease-in-out infinite' }}>
                <Music size={38} color="black" />
              </div>
            </div>
            <h2 style={{ fontSize:'26px', fontWeight:'900', marginBottom:'10px', letterSpacing:'-0.5px' }}>Ready to Jam? 🎵</h2>
            <p style={{ color:'rgba(255,255,255,0.5)', marginBottom:'28px', lineHeight:'1.7', fontSize:'14px' }}>
              Room <strong style={{ color:'#1DB954', fontFamily:'monospace', letterSpacing:'3px', fontSize:'16px' }}>{roomId}</strong><br />
              Tap below to enable audio playback.
            </p>
            <button onClick={handleEnterRoom} style={{ background:'#1DB954', color:'black', fontWeight:'800', padding:'15px 40px', borderRadius:'50px', border:'none', cursor:'pointer', fontSize:'16px', width:'100%', letterSpacing:'0.5px', transition:'transform 0.15s, box-shadow 0.15s', boxShadow:'0 0 24px rgba(29,185,84,0.4)' }}
              onMouseEnter={e => { e.currentTarget.style.transform='scale(1.02)'; e.currentTarget.style.boxShadow='0 0 40px rgba(29,185,84,0.6)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform='scale(1)'; e.currentTarget.style.boxShadow='0 0 24px rgba(29,185,84,0.4)'; }}
            >
              Enter the Jam ⚡
            </button>

          </div>
        </div>
      ) : isMobile ? (
        /* ── MOBILE LAYOUT ── */
        <>
          {/* Mobile Top Bar */}
          <div style={{ background:'#000', padding:'12px 16px', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0, borderBottom:'1px solid #282828' }}>
            <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
              <Music color="#1DB954" size={22} />
              <span style={{ fontWeight:'800', fontSize:'18px' }}>YourJam</span>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:'12px' }}>
              <div style={{ display:'flex', alignItems:'center', gap:'5px', color:'#b3b3b3', fontSize:'12px' }}>
                <Users size={14} /><span>{userCount}</span>
              </div>
              <div style={{ background:'#181818', borderRadius:'8px', padding:'6px 10px', display:'flex', alignItems:'center', gap:'8px' }}>
                <span style={{ fontFamily:'monospace', fontSize:'14px', fontWeight:'800', letterSpacing:'3px', color:'#1DB954' }}>{roomId}</span>
                <button onClick={copyRoomCode} style={{ background:'transparent', border:'none', cursor:'pointer', color:'#b3b3b3', display:'flex', padding:0 }}>
                  {copied ? <CheckCircle2 size={16} color="#1DB954" /> : <Copy size={16} color="#b3b3b3" />}
                </button>
              </div>
            </div>
          </div>

          {/* Mobile Tab Bar */}
          <div style={{ display:'flex', background:'rgba(0,0,0,0.8)', borderBottom:'1px solid rgba(255,255,255,0.07)', flexShrink:0 }}>
            {[['search','🔍'],['queue','📋'],['lyrics','🎤'],['chat','💬']].map(([tab, icon]) => (
              <button key={tab} onClick={() => { setActiveTab(tab); if(tab==='chat'){setUnread(0);setTimeout(()=>chatEndRef.current?.scrollIntoView({behavior:'instant'}),80);} }} style={{ flex:1, padding:'10px 4px', border:'none', background:'transparent', color: activeTab===tab ? '#1DB954' : 'rgba(255,255,255,0.4)', fontWeight: activeTab===tab ? '700' : '400', fontSize:'11px', cursor:'pointer', borderBottom: activeTab===tab ? '2px solid #1DB954' : '2px solid transparent', display:'flex', flexDirection:'column', alignItems:'center', gap:'2px', position:'relative' }}>
                <span style={{ fontSize:'17px' }}>{icon}</span>
                <span style={{ textTransform:'capitalize' }}>{tab}</span>
                {tab==='chat' && unread > 0 && (
                  <span style={{ position:'absolute', top:'6px', right:'calc(50% - 18px)', background:'#1DB954', color:'black', fontSize:'9px', fontWeight:'800', borderRadius:'50%', width:'16px', height:'16px', display:'flex', alignItems:'center', justifyContent:'center' }}>{unread > 9 ? '9+' : unread}</span>
                )}
              </button>
            ))}
          </div>

          {/* Mobile Tab Content */}
          <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}>
            {activeTab === 'search' ? searchPanelJSX : activeTab === 'lyrics' ? lyricsPanelJSX : activeTab === 'chat' ? chatPanelJSX : queuePanelJSX}
          </div>
          {playerBarJSX}
        </>
      ) : (
        /* ── DESKTOP LAYOUT ── */
        <>
          <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
            {/* Glass Sidebar */}
            <div className="glass-dark" style={{ width:'220px', padding:'24px 16px', display:'flex', flexDirection:'column', flexShrink:0, borderRight:'1px solid rgba(255,255,255,0.06)', zIndex:10 }}>
              {/* Logo */}
              <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'28px' }}>
                <div style={{ width:'34px', height:'34px', background:'#1DB954', borderRadius:'10px', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 0 20px rgba(29,185,84,0.5)' }}>
                  <Music size={18} color="black" />
                </div>
                <span style={{ fontSize:'18px', fontWeight:'800', letterSpacing:'-0.5px' }}>YourJam</span>
              </div>

              {/* Room Code */}
              <p style={LABEL}>Room</p>
              <div style={{ background:'rgba(29,185,84,0.08)', border:'1px solid rgba(29,185,84,0.2)', borderRadius:'10px', padding:'14px', marginBottom:'16px' }}>
                <p style={{ fontSize:'10px', color:'rgba(255,255,255,0.4)', marginBottom:'6px', letterSpacing:'1px' }}>ROOM CODE</p>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span style={{ fontFamily:'monospace', fontSize:'20px', fontWeight:'900', letterSpacing:'4px', color:'#1DB954', textShadow:'0 0 12px rgba(29,185,84,0.5)' }}>{roomId}</span>
                  <button onClick={copyRoomCode} style={{ background:'transparent', border:'none', cursor:'pointer', padding:'4px', borderRadius:'6px' }}>
                    {copied ? <CheckCircle2 size={17} color="#1DB954" /> : <Copy size={17} color="rgba(255,255,255,0.4)" />}
                  </button>
                </div>
              </div>

              {/* 💕 Vibe badge */}
              {vibeJSX}

              {/* Listeners + Chat toggle */}
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'24px' }}>
                <div style={{ display:'flex', alignItems:'center', gap:'8px', color:'rgba(255,255,255,0.4)', fontSize:'13px' }}>
                  <Users size={14} /><span>{userCount} listener{userCount!==1?'s':''}</span>
                </div>
                <button onClick={() => chatOpen ? setChatOpen(false) : openChat()} style={{ position:'relative', background: chatOpen ? 'rgba(29,185,84,0.15)' : 'rgba(255,255,255,0.06)', border:`1px solid ${chatOpen ? 'rgba(29,185,84,0.4)' : 'rgba(255,255,255,0.1)'}`, borderRadius:'8px', cursor:'pointer', color: chatOpen ? '#1DB954' : 'rgba(255,255,255,0.5)', padding:'6px 10px', display:'flex', alignItems:'center', gap:'5px', fontSize:'12px', fontWeight:'600', transition:'all 0.2s' }}>
                  <MessageCircle size={14} />
                  <span>Chat</span>
                  {unread > 0 && !chatOpen && (
                    <span style={{ background:'#1DB954', color:'black', fontSize:'9px', fontWeight:'800', borderRadius:'50%', width:'16px', height:'16px', display:'flex', alignItems:'center', justifyContent:'center' }}>{unread}</span>
                  )}
                </button>
              </div>

              {/* Mini now-playing in sidebar */}
              {currentTrack && (
                <div style={{ marginTop:'auto' }}>
                  <p style={LABEL}>Now Playing</p>
                  <div style={{ position:'relative', borderRadius:'12px', overflow:'hidden', boxShadow:`0 8px 32px rgba(${dc},0.3)` }}>
                    <img src={currentTrack.albumArt} alt="" style={{ width:'100%', aspectRatio:'1', objectFit:'cover', display:'block', filter: isPlaying ? 'none' : 'brightness(0.6)' }} />
                    {isPlaying && <div style={{ position:'absolute', inset:0, background:`linear-gradient(to top, rgba(${dc},0.3), transparent)` }} />}
                  </div>
                  <p style={{ fontWeight:'700', marginTop:'10px', fontSize:'13px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', color: isPlaying ? '#1DB954' : 'white', transition:'color 0.3s' }}>{currentTrack.name}</p>
                  <p style={{ color:'rgba(255,255,255,0.4)', fontSize:'12px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{currentTrack.artist}</p>
                </div>
              )}
            </div>

            {/* Center Area — hero + search/queue */}
            <div className="grid-bg" style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:'#060612' }}>
              {heroJSX}
              <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column', background:'rgba(6,6,18,0.9)' }}>
                {searchPanelJSX}
                {!searchTerm && queuePanelJSX}
              </div>
            </div>

            {/* Lyrics Panel */}
            <div className="glass-dark" style={{ width: !chatOpen && (lyrics.length || lyricsLoading) ? '300px' : '0', flexShrink:0, overflow:'hidden', borderLeft:'1px solid rgba(255,255,255,0.06)', transition:'width 0.35s ease', display:'flex', flexDirection:'column' }}>
              {lyricsPanelJSX}
            </div>

            {/* Chat Panel — slides in from right when open */}
            <div className="glass-dark" style={{ width: chatOpen ? '300px' : '0', flexShrink:0, overflow:'hidden', borderLeft:'1px solid rgba(255,255,255,0.06)', transition:'width 0.35s ease', display:'flex', flexDirection:'column' }}>
              {chatPanelJSX}
            </div>
          </div>
          {playerBarJSX}
        </>
      )}
    </div>

  );
}

