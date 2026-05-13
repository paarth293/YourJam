import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import axios from 'axios';
import { Play, Pause, SkipForward, Search, Users, Copy, CheckCircle2, Music, ListMusic, MessageCircle, Send, X, Trash2, LogOut } from 'lucide-react';

// Production backend on Render; local dev uses the current hostname
const SOCKET_URL = import.meta.env.VITE_BACKEND_URL
  || (window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.')
      ? `http://${window.location.hostname}:3001`
      : 'https://yourjam.onrender.com');


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
  const activeTabRef = useRef('queue');
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  const [lyrics, setLyrics] = useState([]);
  const [activeLine, setActiveLine] = useState(0);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [dominantColor, setDominantColor] = useState('29,185,84');
  const lyricsContainerRef = useRef(null);
  // ── Chat state
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [userNameInput, setUserNameInput] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const chatOpenRef = useRef(false);
  useEffect(() => { chatOpenRef.current = chatOpen; }, [chatOpen]);
  const [chatNotif, setChatNotif] = useState(null);
  const [notifLeaving, setNotifLeaving] = useState(false);
  const [unread, setUnread] = useState(0);
  const chatEndRef = useRef(null);
  const notifTimer = useRef(null);
  const myUsername = useRef(''); // will be set when they join
  const sentMsgIds = useRef(new Set()); // tracks optimistic messages to avoid duplicates
  const sentReactionIds = useRef(new Set()); // tracks local reactions to avoid double-fire
  // ── Reactions & fun state
  const [reactions, setReactions] = useState([]);
  const [showConfetti, setShowConfetti] = useState(false);
  const [pendingTrack, setPendingTrack] = useState(null);
  const [dedicationText, setDedicationText] = useState('');
  const [reactionBarOpen, setReactionBarOpen] = useState(false); // collapsible

  const playerRef = useRef(null);
  const isPlayerReadyRef = useRef(false);
  const pendingVideoRef = useRef(null);
  const progressIntervalRef = useRef(null);
  const hasInteractedRef = useRef(false);
  const isPlayingRef = useRef(false);   // mirror of isPlaying for use in event listeners
  const currentTrackRef = useRef(null); // mirror of currentTrack to avoid stale closures
  const silentAudioRef = useRef(null);  // Hack to keep background audio alive on mobile
  const wakeLockRef = useRef(null);     // Keep screen/process awake
  useEffect(() => { currentTrackRef.current = currentTrack; }, [currentTrack]);

  // ── MediaSession API: register as a media player so browser won't suspend us in background
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    if (!currentTrack) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.name || 'Unknown Track',
      artist: currentTrack.artist || 'Unknown Artist',
      album: 'YourJam',
      artwork: currentTrack.albumArt
        ? [{ src: currentTrack.albumArt, sizes: '512x512', type: 'image/jpeg' }]
        : [],
    });
    navigator.mediaSession.setActionHandler('play', () => {
      if (socketRef.current?.connected) socketRef.current.emit('play', roomId);
      setIsPlaying(true);
      isPlayingRef.current = true;
      playerRef.current?.playVideo?.();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      if (socketRef.current?.connected) socketRef.current.emit('pause', roomId);
      setIsPlaying(false);
      isPlayingRef.current = false;
      playerRef.current?.pauseVideo?.();
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      socketRef.current?.emit('skip', roomId);
    });
  }, [currentTrack, roomId]);

  // Keep MediaSession playback state in sync + keep isPlayingRef current
  useEffect(() => {
    isPlayingRef.current = isPlaying;
    if (!('mediaSession' in navigator)) return;
    
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';

    // Update position state for the OS lock screen
    if (isPlaying && duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: duration || 0,
          playbackRate: 1,
          position: progress || 0,
        });
      } catch (e) {
        console.error("MediaSession setPositionState error:", e);
      }
    }
  }, [isPlaying, duration, progress]);

  // Keep hasInteractedRef in sync
  useEffect(() => { hasInteractedRef.current = hasInteracted; }, [hasInteracted]);

  // ── Resume playback when user switches back to this tab (mobile tab switching fix)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        // Tab went to background — ensure wake lock is active if playing
        if (isPlayingRef.current) {
          requestWakeLock();
        }
        return;
      }
      
      // Tab is visible again — if we should be playing, kick the player
      if (isPlayingRef.current && isPlayerReadyRef.current && playerRef.current) {
        setTimeout(() => {
          try {
            const state = playerRef.current?.getPlayerState?.();
            // 2 = paused, -1 = unstarted/ended — resume in either case
            if (state === 2 || state === -1 || state === 0) {
              playerRef.current.playVideo?.();
            }
          } catch (_) {}
        }, 400);
      }
      // Also ask server for the authoritative position so we can seek to correct time
      socketRef.current?.emit('request-sync', roomId);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      releaseWakeLock();
    };
  }, [roomId]);  // roomId is stable, refs handle the rest

  // ── Screen Wake Lock API: Prevent mobile sleep
  const requestWakeLock = async () => {
    if ('wakeLock' in navigator && !wakeLockRef.current) {
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        console.log('✅ Wake Lock active');
        wakeLockRef.current.addEventListener('release', () => {
          console.log('🔒 Wake Lock released');
          wakeLockRef.current = null;
        });
      } catch (err) {
        console.error(`${err.name}, ${err.message}`);
      }
    }
  };

  const releaseWakeLock = () => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release();
      wakeLockRef.current = null;
    }
  };

  // Responsive: track window width
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── Mobile back-button intercept
  // IMPORTANT: no activeTab in deps — we use activeTabRef to avoid re-running on every tab change
  // (re-running pushes duplicate history entries, breaking the history stack)
  useEffect(() => {
    if (!isMobile) return;
    window.history.pushState({ room: true }, '');
    const handlePop = () => {
      if (activeTabRef.current !== 'queue') {
        setActiveTab('queue');
        activeTabRef.current = 'queue';
        window.history.pushState({ room: true }, '');
      } else {
        window.history.back();
      }
    };
    window.addEventListener('popstate', handlePop);
    return () => window.removeEventListener('popstate', handlePop);
  }, [isMobile]); // ← activeTab intentionally excluded — use ref instead

  // Debounced dynamic search — fires 500ms after user stops typing
  useEffect(() => {
    if (!searchTerm.trim()) return; // don't wipe results when modal opens
    setIsSearching(true);            // show spinner immediately
    const timer = setTimeout(async () => {
      try {
        const res = await axios.get(`${SOCKET_URL}/api/search?q=${encodeURIComponent(searchTerm.trim())}`);
        if (Array.isArray(res.data)) setSearchResults(res.data);
      } catch (err) {
        console.error('Search failed:', err.message);
        // Keep old results visible on error
      } finally {
        setIsSearching(false);
      }
    }, 500);
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
    // Auto-scroll ONLY when user is actually on the lyrics tab
    if (activeTabRef.current !== 'lyrics') return;
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
            setDuration(playerRef.current.getDuration?.() || 0);
          }
          // ── Earbud/headphone disconnect fix ──
          // When earbuds disconnect, browser pauses YT player (state 2)
          // We detect this and emit pause to server so ALL devices sync
          if (evt.data === window.YT.PlayerState.PAUSED) {
            if (isPlayingRef.current) {  // we thought it was playing → external pause
              setIsPlaying(false);
              isPlayingRef.current = false;
              socketRef.current?.emit('pause', roomId);
            }
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

    // ── Unified sync-state handler — used for BOTH initial join AND mid-session resync
    socket.on('sync-state', (state) => {
      const { queue: sQueue, currentTrack: sTrack, currentTime: sTime, isPlaying: sPlaying } = state;
      // Always update queue and UI state
      if (sQueue) setQueue(sQueue);
      setCurrentTrack(sTrack || null);
      setIsPlaying(!!sPlaying);

      if (!sTrack?.youtubeId) return;
      if (!hasInteractedRef.current) return;  // can't touch player before user tap

      if (isPlayerReadyRef.current && playerRef.current) {
        const playerState = playerRef.current.getPlayerState?.();
        const correctedTime = (sTime || 0) + 0.5;  // +0.5s to cover network roundtrip

        if (playerState === -1 || playerState === 0) {
          // Player has no video / ended — load fresh with correct start time
          playerRef.current.loadVideoById({ videoId: sTrack.youtubeId, startSeconds: correctedTime });
          if (!sPlaying) setTimeout(() => playerRef.current?.pauseVideo?.(), 600);
        } else {
          // Video already loaded — just seek to correct position
          playerRef.current.seekTo?.(correctedTime, true);
          if (sPlaying) {
            setTimeout(() => playerRef.current?.playVideo?.(), 300);
          } else {
            playerRef.current.pauseVideo?.();
          }
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
      isPlayingRef.current = true;
      if (isPlayerReadyRef.current && playerRef.current) {
        const state = playerRef.current.getPlayerState?.();
        const track = currentTrackRef.current; // use ref, not stale closure
        if (state === -1 && track?.youtubeId) {
          playerRef.current.loadVideoById(track.youtubeId);
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

    socket.on('reaction', ({ emoji, id, localId }) => {
      // If this is our own reaction echoed back, suppress it (we already showed it locally)
      if (localId && sentReactionIds.current.has(localId)) {
        sentReactionIds.current.delete(localId);
        return;
      }
      const x = 8 + Math.random() * 84;
      setReactions(prev => [...prev, { emoji, id, x }]);
      setTimeout(() => setReactions(prev => prev.filter(r => r.id !== id)), 3000);
    });

    socket.on('chat-message', (msg) => {
      // Skip if we already added this message optimistically
      if (sentMsgIds.current.has(msg.id)) {
        sentMsgIds.current.delete(msg.id);
        return;
      }
      setMessages(prev => [...prev, msg]);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      // Use refs so we always read current tab/chat state — no stale closure
      const isChatVisible = chatOpenRef.current || activeTabRef.current === 'chat';
      if (!isChatVisible) {
        setUnread(n => n + 1);
        clearTimeout(notifTimer.current);
        setNotifLeaving(false);
        setChatNotif(msg);
        notifTimer.current = setTimeout(() => {
          setNotifLeaving(true);
          setTimeout(() => setChatNotif(null), 300);
        }, 4000);
      }
    });

    // ── Service Worker Heartbeat: Keep background process alive
    const swHeartbeat = setInterval(() => {
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'KEEP_ALIVE' });
      }
    }, 10000);

    return () => {
      socket.disconnect();
      clearInterval(progressIntervalRef.current);
      clearInterval(swHeartbeat);
      clearTimeout(notifTimer.current);
    };
  }, [roomId, navigate, loadAndPlay]);

  // Send a chat message — optimistically add to local state immediately
  const sendMessage = () => {
    const text = chatInput.trim();
    if (!text) return;
    const msgId = `${Date.now()}-local-${Math.random()}`;
    const optimisticMsg = {
      id: msgId,
      message: text,
      user: myUsername.current,
      senderId: 'me',
      timestamp: Date.now(),
    };
    // Show immediately — don't wait for server echo
    setMessages(prev => [...prev, optimisticMsg]);
    sentMsgIds.current.add(msgId);
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    setChatInput('');
    // Emit to server so others get it
    if (socketRef.current?.connected) {
      socketRef.current.emit('chat-message', { roomId, message: text, user: myUsername.current });
    }
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

  // Send an emoji reaction to all users + show it locally immediately
  const sendReaction = (emoji) => {
    // Generate a stable ID to track this reaction across local + server echo
    const reactionId = `${Date.now()}-${Math.random()}`;
    const x = 8 + Math.random() * 84;
    // Show immediately on sender's screen
    setReactions(prev => [...prev, { emoji, id: reactionId, x }]);
    setTimeout(() => setReactions(prev => prev.filter(r => r.id !== reactionId)), 3000);
    // Mark as locally sent so socket listener doesn't double-show it
    sentReactionIds.current.add(reactionId);
    // Emit to server with the same ID
    if (socketRef.current?.connected) {
      socketRef.current.emit('reaction', { roomId, emoji, localId: reactionId });
    }
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
    setSearchTerm('');
    setSearchResults([]);
    if (isMobile) setActiveTab('queue');

  };


  useEffect(() => {
    clearInterval(progressIntervalRef.current);
    if (isPlaying && hasInteracted) {
      // Request wake lock while playing
      requestWakeLock();
      
      progressIntervalRef.current = setInterval(() => {
        if (isPlayerReadyRef.current && playerRef.current?.getCurrentTime) {
          const t = playerRef.current.getCurrentTime();
          const d = playerRef.current.getDuration?.() || 0;
          setProgress(t);
          setDuration(d);
          socketRef.current?.emit('sync-time', { roomId, time: t });
          
          // Ensure silent audio stays playing (sometimes mobile pauses it)
          if (silentAudioRef.current && silentAudioRef.current.paused) {
            silentAudioRef.current.play().catch(() => {});
          }
        }
      }, 1000);
    } else {
      releaseWakeLock();
    }
    return () => clearInterval(progressIntervalRef.current);
  }, [isPlaying, hasInteracted, roomId]);

  // ─── Handlers ─────────────────────────────────────────────────────────────
  const handleEnterRoom = () => {
    const name = userNameInput.trim();
    if (!name) {
      alert("Please enter a name so your friends know it's you!");
      return;
    }
    myUsername.current = name;
    setHasInteracted(true);
    hasInteractedRef.current = true;
    
    // START SILENT AUDIO HACK: Mobile browsers suspend iframes in the background.
    // Natively playing an HTML5 audio element grabs the OS background audio session.
    // The YT iframe then "rides along" and isn't suspended.
    if (silentAudioRef.current) {
      silentAudioRef.current.play().catch(e => console.log("Silent audio failed to start:", e));
    }
    
    // Tell the backend our name for tracking/telemetry
    socketRef.current?.emit('identify', { roomId, username: name });

    // Request authoritative sync — sync-state handler will load+seek to correct position
    // Small delay to ensure hasInteractedRef is true before sync-state fires
    setTimeout(() => {
      socketRef.current?.emit('request-sync', roomId);
    }, 100);
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
    socketRef.current?.emit('add-track', { roomId, track });
    setSearchTerm('');
    setSearchResults([]);
  };

  const togglePlay = () => {
    if (!currentTrack || !isPlayerReadyRef.current) return;
    if (isPlaying) {
      // Pause immediately locally, then broadcast
      playerRef.current?.pauseVideo?.();
      setIsPlaying(false);
      socketRef.current?.emit('pause', roomId);
    } else {
      // Play immediately locally, then broadcast
      playerRef.current?.playVideo?.();
      setIsPlaying(true);
      socketRef.current?.emit('play', roomId);
    }
  };

  const handleSkip = () => {
    socketRef.current?.emit('skip', roomId);
  };

  const handleRemoveTrack = (trackId) => {
    socketRef.current?.emit('remove-track', { roomId, trackId });
  };

  const handleLeaveRoom = () => {
    if (!window.confirm("Are you sure you want to leave the jam?")) return;
    
    // Pause local playback
    playerRef.current?.pauseVideo?.();
    setIsPlaying(false);
    
    // Disconnect and go home
    socketRef.current?.disconnect();
    navigate('/');
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
      {/* Bottom fade to Spotify Dark */}
      <div style={{ position:'absolute', bottom:0, left:0, right:0, height:'80px', background:'linear-gradient(to bottom, transparent, #121212)', zIndex:2 }} />
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

  // ── 🎭 Reaction bar — collapsible pill (toggle button + emoji grid)
  // Hide when chat is visible so it doesn't cover the send button
  const chatIsVisible = chatOpen || activeTab === 'chat';
  const EMOJIS = ['❤️','🔥','😍','🎵','✨','💫','😂','🎉','👏','💕'];
  const reactionBarJSX = hasInteracted && !chatIsVisible ? (
    <div style={{ position:'fixed', right:'12px', bottom:'120px', zIndex:200, display:'flex', flexDirection:'column', alignItems:'flex-end', gap:'6px' }}>
      {/* Expanded emoji grid */}
      {reactionBarOpen && (
        <div style={{
          background:'rgba(10,10,28,0.92)', backdropFilter:'blur(20px)',
          border:'1px solid rgba(255,255,255,0.1)', borderRadius:'20px',
          padding:'10px 7px', display:'grid', gridTemplateColumns:'1fr 1fr',
          gap:'4px', boxShadow:'0 12px 40px rgba(0,0,0,0.6)',
        }}>
          {EMOJIS.map(e => (
            <button key={e} className="react-btn"
              style={{ width:'40px', height:'40px', fontSize:'20px' }}
              onClick={() => { sendReaction(e); }}
              title={`React ${e}`}
            >{e}</button>
          ))}
        </div>
      )}
      {/* Toggle button */}
      <button
        onClick={() => setReactionBarOpen(o => !o)}
        style={{
          width:'44px', height:'44px', borderRadius:'50%',
          background: reactionBarOpen ? 'rgba(29,185,84,0.25)' : 'rgba(10,10,28,0.85)',
          border:`1px solid ${reactionBarOpen ? 'rgba(29,185,84,0.5)' : 'rgba(255,255,255,0.12)'}`,
          backdropFilter:'blur(16px)',
          cursor:'pointer', fontSize:'22px',
          display:'flex', alignItems:'center', justifyContent:'center',
          boxShadow:'0 4px 20px rgba(0,0,0,0.4)',
          transition:'all 0.2s',
        }}
        title={reactionBarOpen ? 'Close reactions' : 'Open reactions'}
      >
        {reactionBarOpen ? '✕' : '💕'}
      </button>
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
      {!isQueue ? (
        <button
          onClick={() => handleAddTrack(track)}
          style={{
            flexShrink:0, width:'30px', height:'30px', borderRadius:'50%',
            background:'rgba(29,185,84,0.15)', border:'1px solid rgba(29,185,84,0.4)', color:'#1DB954',
            display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer',
            fontSize:'18px', fontWeight:'300', lineHeight:1, transition:'background 0.15s, transform 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background='rgba(29,185,84,0.35)'; e.currentTarget.style.transform='scale(1.12)'; }}
          onMouseLeave={e => { e.currentTarget.style.background='rgba(29,185,84,0.15)'; e.currentTarget.style.transform='scale(1)'; }}
          title="Add to queue"
        >+</button>
      ) : (
        <button
          onClick={() => handleRemoveTrack(track.id)}
          style={{
            flexShrink:0, width:'30px', height:'30px', borderRadius:'8px',
            background:'transparent', color:'rgba(255,255,255,0.3)', border:'none',
            display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer', transition:'all 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.color='#ff4444'; e.currentTarget.style.background='rgba(255,68,68,0.1)'; }}
          onMouseLeave={e => { e.currentTarget.style.color='rgba(255,255,255,0.3)'; e.currentTarget.style.background='transparent'; }}
          title="Remove from queue"
        ><Trash2 size={16} /></button>
      )}
    </div>
  ));

  const lyricsPanelJSX = (
    <div ref={lyricsContainerRef} style={{ flex:1, minHeight:0, overflowY:'auto', padding: isMobile ? '16px' : '16px 24px 24px', scrollBehavior:'smooth' }}>
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
    // Mobile: flex:1+minHeight:0 fills tab area correctly
    // Desktop: height:100% fills the fixed-width sidebar panel
    <div style={{ display:'flex', flexDirection:'column', ...(isMobile ? { flex:1, minHeight:0 } : { height:'100%' }) }}>
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

      {/* Messages — flex:1 + minHeight:0 + overflowY:auto for proper scroll */}
      <div style={{ flex:1, minHeight:0, overflowY:'auto', padding:'16px', display:'flex', flexDirection:'column', gap:'10px' }}>
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
    <div style={{ display:'flex', flexDirection:'column', flex:1, minHeight:0, overflow:'hidden' }}>
      {/* Search input */}
      <div style={{ padding: isMobile ? '12px 16px 8px' : '20px 24px 8px', flexShrink:0 }}>
        <div style={{ position:'relative', maxWidth: isMobile ? '100%' : '520px' }}>
          <span style={{ position:'absolute', left:'16px', top:'50%', transform:'translateY(-50%)', color:'rgba(255,255,255,0.35)', pointerEvents:'none' }}>
            <Search size={17} />
          </span>
          <input
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search songs, artists..."
            style={{
              width:'100%', boxSizing:'border-box',
              background:'rgba(255,255,255,0.07)',
              border:'1px solid rgba(255,255,255,0.1)',
              borderRadius:'50px', color:'white',
              padding:'11px 20px 11px 46px',
              fontSize:'14px', outline:'none',
              fontFamily:'inherit',
              transition:'border-color 0.2s, background 0.2s',
            }}
            onFocus={e => { e.currentTarget.style.background='rgba(255,255,255,0.11)'; e.currentTarget.style.borderColor='rgba(29,185,84,0.5)'; }}
            onBlur={e =>  { e.currentTarget.style.background='rgba(255,255,255,0.07)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.1)'; }}
          />
          {isSearching && (
            <span style={{ position:'absolute', right:'16px', top:'50%', transform:'translateY(-50%)' }}>
              <div style={{ width:'16px', height:'16px', border:'2px solid rgba(255,255,255,0.2)', borderTop:'2px solid #1DB954', borderRadius:'50%', animation:'vinyl-spin 0.7s linear infinite' }} />
            </span>
          )}
          {searchTerm && !isSearching && (
            <button onClick={() => { setSearchTerm(''); setSearchResults([]); }}
              style={{ position:'absolute', right:'14px', top:'50%', transform:'translateY(-50%)', background:'rgba(255,255,255,0.1)', border:'none', borderRadius:'50%', width:'20px', height:'20px', cursor:'pointer', color:'rgba(255,255,255,0.5)', display:'flex', alignItems:'center', justifyContent:'center', padding:0 }}>
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Results */}
      <div style={{ flex:1, minHeight:0, overflowY:'auto', padding: isMobile ? '4px 8px 16px' : '4px 16px 24px' }}>
        {/* Empty/placeholder state */}
        {!searchTerm && searchResults.length === 0 && (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'48px 24px', color:'rgba(255,255,255,0.25)', gap:'12px' }}>
            <Search size={44} style={{ opacity:0.3 }} />
            <p style={{ fontWeight:'700', fontSize:'16px' }}>Search for a song</p>
            <p style={{ fontSize:'13px' }}>Results appear as you type ✨</p>
          </div>
        )}
        {/* No results */}
        {!isSearching && searchTerm && searchResults.length === 0 && (
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', padding:'40px 24px', color:'rgba(255,255,255,0.3)', gap:'10px' }}>
            <span style={{ fontSize:'36px' }}>🤔</span>
            <p style={{ fontWeight:'600' }}>No results for "<span style={{ color:'white' }}>{searchTerm}</span>"</p>
            <p style={{ fontSize:'12px' }}>Try a different song or artist name</p>
          </div>
        )}
        {/* Results list */}
        {searchResults.length > 0 && (
          <>
            <p style={{ fontSize:'11px', color:'rgba(255,255,255,0.3)', padding:'4px 8px 8px', letterSpacing:'1px' }}>RESULTS — {searchResults.length} songs</p>
            {trackListJSX(searchResults, false)}
          </>
        )}
      </div>
    </div>
  );


  const queuePanelJSX = (
    <div style={{ flex:1, minHeight:0, overflowY:'auto' }}>
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
    <div style={{
      background:'rgba(18,18,18,0.98)',
      borderTop:'1px solid rgba(255,255,255,0.07)',
      backdropFilter:'blur(20px)',
      flexShrink:0,
      position:'relative',
      zIndex:10,
      // Mobile: compact single row; Desktop: 3-col tall bar
      height: isMobile ? '64px' : '88px',
      display:'flex',
      flexDirection:'row',
      alignItems:'center',
      padding: isMobile ? '0 12px' : '0 24px',
      gap: isMobile ? '10px' : '0',
      justifyContent:'space-between',
    }}>
      {/* Ambient aura — pointer-events:none so it never blocks */}
      {isPlaying && currentTrack && (
        <div className="aura" style={{ position:'absolute', width:'300px', height:'300px', bottom:'-150px', left:'50%', transform:'translateX(-50%)', pointerEvents:'none', zIndex:0 }} />
      )}

      {/* LEFT — Album art + track name */}
      <div style={{ display:'flex', alignItems:'center', gap:'10px', flex:1, minWidth:0, position:'relative', zIndex:1 }}>
        {currentTrack ? (
          <>
            <div className={isPlaying ? 'glow-playing' : ''} style={{ borderRadius:'50%', flexShrink:0, width: isMobile?'40px':'52px', height: isMobile?'40px':'52px' }}>
              <img src={currentTrack.albumArt} className={isPlaying ? 'vinyl-spinning' : 'vinyl-paused'} style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }} alt="" />
            </div>
            <div style={{ minWidth:0 }}>
              <div style={{ display:'flex', alignItems:'center', gap:'5px' }}>
                <div style={{ fontWeight:'600', fontSize: isMobile?'13px':'14px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', color: isPlaying ? '#1DB954' : 'white', transition:'color 0.3s' }}>{currentTrack.name}</div>
                <div style={{ display:'flex', alignItems:'flex-end', gap:'2px', height:'16px', flexShrink:0 }}>
                  {[0,1,2,3].map(i => (
                    <div key={i} className={`eq-bar${isPlaying ? '' : ' eq-bar-paused'}`} style={{ height: i%2===0?'10px':'6px' }} />
                  ))}
                </div>
              </div>
              <div style={{ color:'rgba(255,255,255,0.4)', fontSize:'12px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{currentTrack.artist}</div>
            </div>
          </>
        ) : (
          <div style={{ color:'rgba(255,255,255,0.4)', fontSize:'13px' }}>Nothing playing yet</div>
        )}
      </div>

      {/* CENTER (desktop only) — play controls + progress bar */}
      {!isMobile && (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', width:'40%', position:'relative', zIndex:1 }}>
          <div style={{ display:'flex', alignItems:'center', gap:'20px', marginBottom:'6px' }}>
            <button onClick={togglePlay} disabled={!currentTrack}
              style={{ width:'38px', height:'38px', borderRadius:'50%', background: isPlaying?'#1DB954':'white', border:'none', cursor: currentTrack?'pointer':'not-allowed', display:'flex', alignItems:'center', justifyContent:'center', opacity: currentTrack?1:0.4, transition:'background 0.2s, box-shadow 0.2s', boxShadow: isPlaying?'0 0 20px rgba(29,185,84,0.5)':'none' }}
              onMouseEnter={e => { if(currentTrack) e.currentTarget.style.transform='scale(1.08)'; }}
              onMouseLeave={e => e.currentTarget.style.transform='scale(1)'}
            >
              {isPlaying ? <Pause size={18} fill="black" color="black" /> : <Play size={18} fill="black" color="black" style={{ marginLeft:'2px' }} />}
            </button>
            <button onClick={handleSkip} disabled={!currentTrack} style={{ background:'transparent', border:'none', color:'rgba(255,255,255,0.5)', cursor: currentTrack?'pointer':'not-allowed', display:'flex', alignItems:'center', opacity: currentTrack?1:0.4 }}>
              <SkipForward size={22} fill="currentColor" />
            </button>
          </div>
          {/* Progress bar */}
          <div style={{ display:'flex', alignItems:'center', gap:'8px', width:'100%', fontSize:'11px', color:'rgba(255,255,255,0.5)' }}>
            <span style={{ minWidth:'32px', textAlign:'right', fontVariantNumeric:'tabular-nums' }}>{formatTime(progress)}</span>
            <div style={{ flex:1, height:'4px', background:'rgba(255,255,255,0.1)', borderRadius:'4px', overflow:'hidden', cursor:'pointer' }}
              onClick={e => {
                if (!currentTrack || !duration) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const seekTo = ((e.clientX - rect.left) / rect.width) * duration;
                playerRef.current?.seekTo?.(seekTo, true);
                socketRef.current?.emit('seek', { roomId, time: seekTo });
              }}
            >
              <div className={isPlaying ? 'progress-playing' : ''} style={{ height:'100%', width:`${progressPct}%`, background: isPlaying ? undefined : 'rgba(255,255,255,0.6)', borderRadius:'4px', transition:'width 0.5s linear' }} />
            </div>
            <span style={{ minWidth:'32px', fontVariantNumeric:'tabular-nums' }}>{formatTime(duration)}</span>
          </div>
        </div>
      )}

      {/* RIGHT — play/skip on mobile, user count on desktop */}
      <div style={{ display:'flex', alignItems:'center', gap: isMobile?'8px':'6px', position:'relative', zIndex:1, flexShrink:0 }}>
        {isMobile ? (
          // Mobile: compact play + skip buttons on the right
          <>
            <button onClick={togglePlay} disabled={!currentTrack}
              style={{ width:'44px', height:'44px', borderRadius:'50%', background: isPlaying?'#1DB954':'white', border:'none', cursor: currentTrack?'pointer':'not-allowed', display:'flex', alignItems:'center', justifyContent:'center', opacity: currentTrack?1:0.4, boxShadow: isPlaying?'0 0 16px rgba(29,185,84,0.6)':'none', transition:'background 0.2s, box-shadow 0.2s', flexShrink:0 }}
            >
              {isPlaying ? <Pause size={20} fill="black" color="black" /> : <Play size={20} fill="black" color="black" style={{ marginLeft:'2px' }} />}
            </button>
            <button onClick={handleSkip} disabled={!currentTrack} style={{ background:'rgba(255,255,255,0.07)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:'50%', width:'36px', height:'36px', cursor: currentTrack?'pointer':'not-allowed', display:'flex', alignItems:'center', justifyContent:'center', color:'rgba(255,255,255,0.7)', opacity: currentTrack?1:0.4 }}>
              <SkipForward size={18} fill="currentColor" />
            </button>
          </>
        ) : (
          // Desktop: listener count
          <div style={{ color:'rgba(255,255,255,0.4)', fontSize:'13px', display:'flex', alignItems:'center', gap:'5px' }}>
            <Users size={15} /><span>{userCount}</span>
          </div>
        )}
      </div>
    </div>
  );


  // ─── Main Room UI ─────────────────────────────────────────────────────────
  return (
    <div style={{ position:'relative', height:'100dvh', width:'100vw', overflow:'hidden', backgroundColor:'#121212', color:'white' }}>
      {/* ── BACKGROUND AUDIO HACK ── */}
      {/* Plays silence endlessly to hold the mobile OS background audio lock */}
      <audio 
        ref={silentAudioRef} 
        loop 
        playsInline 
        src="data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYxLjEuMTAwAAAAAAAAAAAAAAD/+0DEAAAAAABAAKWAAAAAQAAMAAAAP/7QgQAAAAAEEAApYAAAAAAAwAAAAAAA//tAxAAAAAAAQAClgAAAAEAADAAAAD/+0IEAAAAABBAAKWAAAAAAAMAAAAAAA//tAxAAAAAAAQAClgAAAAEAADAAAAD/+0IEAAAAABBAAKWAAAAAAAMAAAAAAA//tAxAAAAAAAQAClgAAAAEAADAAAAD/+0IEAAAAABBAAKWAAAAAAAMAAAAAAA//tAxAAAAAAAQAClgAAAAEAADAAAAD/+0IEAAAAABBAAKWAAAAAAAMAAAAAAA//tAxAAAAAAAQAClgAAAAEAADAAAAD/+0IEAAAAABBAAKWAAAAAAAMAAAAAAA" 
      />

      {/* ── YOUTUBE PLAYER (Anti-Suspension placement) ── */}
      {/* Must be physically large so the browser thinks it's visible, but tucked behind UI (z-index 0) */}
      <div style={{ position:'absolute', top:0, left:0, width:'100%', height:'100%', pointerEvents:'none', zIndex:0, overflow:'hidden', opacity: 0.01 }}>
        <div id="yt-player-container"></div>
      </div>

      {/* ── MAIN APP CONTENT (z-index 10 covering the player) ── */}
      <div style={{ display:'flex', flexDirection:'column', height:'100%', width:'100%', position:'relative', zIndex:10, backgroundColor:'#121212' }}>
        {notifJSX}
        {confettiJSX}
        {reactionParticlesJSX}
        {reactionBarJSX}
        {dedicationModalJSX}

        {!hasInteracted ? (
        <div className="grid-bg" style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', background:'#121212', padding:'20px' }}>
          {/* Radial glow */}
          <div style={{ position:'absolute', width:'600px', height:'600px', borderRadius:'50%', background:'radial-gradient(circle, rgba(29,185,84,0.12) 0%, transparent 70%)', pointerEvents:'none' }} />
          <div className="glass" style={{ textAlign:'center', padding:'48px 40px', borderRadius:'24px', maxWidth:'420px', width:'100%', boxShadow:'0 32px 80px rgba(0,0,0,0.7)', border:'1px solid rgba(29,185,84,0.15)', position:'relative' }}>
            <div style={{ display:'flex', justifyContent:'center', marginBottom:'28px' }}>
              <div style={{ width:'80px', height:'80px', background:'#1DB954', borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 0 50px rgba(29,185,84,0.6)', animation:'pulse-glow 2s ease-in-out infinite' }}>
                <Music size={38} color="black" />
              </div>
            </div>
            <h2 style={{ fontSize:'26px', fontWeight:'900', marginBottom:'10px', letterSpacing:'-0.5px' }}>Ready to Jam? 🎵</h2>
            <p style={{ color:'rgba(255,255,255,0.5)', marginBottom:'20px', lineHeight:'1.7', fontSize:'14px' }}>
              Room <strong style={{ color:'#1DB954', fontFamily:'monospace', letterSpacing:'3px', fontSize:'16px' }}>{roomId}</strong><br />
            </p>
            
            <input
              type="text"
              className="chat-input"
              style={{ width:'100%', marginBottom:'24px', textAlign:'center', fontSize:'16px', padding:'14px', borderRadius:'12px', border:'1px solid rgba(255,255,255,0.2)' }}
              placeholder="What's your name?"
              value={userNameInput}
              onChange={e => setUserNameInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleEnterRoom()}
              maxLength={20}
              autoFocus
            />

            <button onClick={handleEnterRoom} style={{ background:'#1DB954', color:'black', fontWeight:'800', padding:'15px 40px', borderRadius:'50px', border:'none', cursor:'pointer', fontSize:'16px', width:'100%', letterSpacing:'0.5px', transition:'transform 0.15s, box-shadow 0.15s', opacity: userNameInput.trim() ? 1 : 0.5, boxShadow: userNameInput.trim() ? '0 0 24px rgba(29,185,84,0.4)' : 'none' }}
              disabled={!userNameInput.trim()}
              onMouseEnter={e => { if(userNameInput.trim()){ e.currentTarget.style.transform='scale(1.02)'; e.currentTarget.style.boxShadow='0 0 40px rgba(29,185,84,0.6)'; } }}
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
          <div style={{ background:'rgba(18,18,18,0.98)', padding:'10px 16px', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0, borderBottom:'1px solid rgba(255,255,255,0.07)', backdropFilter:'blur(20px)' }}>
            <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
              <Music color="#1DB954" size={20} />
              <span style={{ fontWeight:'800', fontSize:'17px' }}>YourJam</span>
              {activeTab !== 'queue' && (
                <span style={{ color:'rgba(255,255,255,0.3)', fontSize:'11px', marginLeft:'4px' }}>
                  / {activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}
                </span>
              )}
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
              <div style={{ display:'flex', alignItems:'center', gap:'5px', color:'rgba(255,255,255,0.4)', fontSize:'12px' }}>
                <Users size={13} /><span>{userCount}</span>
              </div>
              <div style={{ background:'rgba(29,185,84,0.1)', border:'1px solid rgba(29,185,84,0.25)', borderRadius:'8px', padding:'4px 9px', display:'flex', alignItems:'center', gap:'6px' }}>
                <span style={{ fontFamily:'monospace', fontSize:'12px', fontWeight:'800', letterSpacing:'2px', color:'#1DB954' }}>{roomId}</span>
                <button onClick={copyRoomCode} style={{ background:'transparent', border:'none', cursor:'pointer', color:'rgba(255,255,255,0.4)', display:'flex', padding:0 }}>
                  {copied ? <CheckCircle2 size={14} color="#1DB954" /> : <Copy size={14} color="rgba(255,255,255,0.4)" />}
                </button>
              </div>
              <button onClick={handleLeaveRoom} style={{ background:'rgba(255,68,68,0.1)', border:'1px solid rgba(255,68,68,0.3)', borderRadius:'8px', width:'28px', height:'28px', display:'flex', alignItems:'center', justifyContent:'center', color:'#ff4444', cursor:'pointer' }}>
                <LogOut size={14} />
              </button>
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

          {/* Mobile Tab Content — minHeight:0 is critical for flex children to scroll correctly */}
          <div style={{ flex:1, minHeight:0, overflow:'hidden', display:'flex', flexDirection:'column' }}>
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

              {/* Leave Jam Button */}
              <button onClick={handleLeaveRoom} style={{ marginTop: currentTrack ? '24px' : 'auto', background:'transparent', border:'1px solid rgba(255,68,68,0.3)', borderRadius:'12px', color:'#ff4444', padding:'12px', display:'flex', alignItems:'center', justifyContent:'center', gap:'8px', cursor:'pointer', fontSize:'13px', fontWeight:'600', transition:'all 0.2s' }}
                onMouseEnter={e => { e.currentTarget.style.background='rgba(255,68,68,0.1)'; e.currentTarget.style.borderColor='rgba(255,68,68,0.5)'; }}
                onMouseLeave={e => { e.currentTarget.style.background='transparent'; e.currentTarget.style.borderColor='rgba(255,68,68,0.3)'; }}
              >
                <LogOut size={16} /> Leave Jam
              </button>
            </div>

            {/* Center Area — hero + search/queue */}
            <div className="grid-bg" style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:'#121212' }}>
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
    </div>

  );
}

