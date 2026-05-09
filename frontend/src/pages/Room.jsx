import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import axios from 'axios';
import { Play, Pause, SkipForward, Search, Users, Copy, CheckCircle2, Music, ListMusic } from 'lucide-react';

// Bulletproof YouTube player helper
// Instead of calling playerRef.current?.loadVideoById directly everywhere,
// we use this helper that queues the command if the player isn't ready yet.

const SOCKET_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

// ─── Styles ────────────────────────────────────────────────────────────────
const S = {
  root: { display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden', backgroundColor: '#121212', color: 'white' },
  main: { display: 'flex', flex: 1, overflow: 'hidden' },
  sidebar: { width: '240px', background: '#000', padding: '24px 16px', display: 'flex', flexDirection: 'column', flexShrink: 0 },
  logo: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '32px', paddingLeft: '8px' },
  logoText: { fontSize: '20px', fontWeight: '800' },
  sectionLabel: { color: '#b3b3b3', fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '1px', padding: '0 8px', marginBottom: '12px' },
  roomCard: { background: '#181818', borderRadius: '8px', padding: '16px', marginBottom: '16px' },
  roomCodeLabel: { color: '#b3b3b3', fontSize: '11px', marginBottom: '6px' },
  roomCodeRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  roomCode: { fontFamily: 'monospace', fontSize: '22px', fontWeight: '800', letterSpacing: '4px', color: '#1DB954' },
  userCount: { display: 'flex', alignItems: 'center', gap: '6px', color: '#b3b3b3', fontSize: '13px', marginTop: '12px', paddingLeft: '0' },
  centerArea: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'linear-gradient(180deg, #2a2a2a 0%, #121212 300px)' },
  searchBar: { padding: '20px 24px 8px', flexShrink: 0 },
  searchWrap: { position: 'relative', maxWidth: '480px' },
  searchIcon: { position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', color: '#b3b3b3', pointerEvents: 'none' },
  searchInput: { width: '100%', background: '#242424', border: 'none', borderRadius: '50px', color: 'white', padding: '12px 20px 12px 48px', fontSize: '14px', outline: 'none', transition: 'background 0.2s', boxSizing: 'border-box' },
  scrollArea: { flex: 1, overflowY: 'auto', padding: '16px 24px 24px' },
  sectionTitle: { fontSize: '22px', fontWeight: '800', marginBottom: '20px' },
  trackRow: { display: 'flex', alignItems: 'center', padding: '8px', borderRadius: '6px', cursor: 'pointer', transition: 'background 0.15s', gap: '14px', position: 'relative' },
  trackArt: { width: '42px', height: '42px', borderRadius: '4px', objectFit: 'cover', flexShrink: 0, background: '#333' },
  trackName: { fontWeight: '500', fontSize: '15px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '260px' },
  trackArtist: { color: '#b3b3b3', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '260px' },
  addBtn: { marginLeft: 'auto', border: '1px solid #b3b3b3', background: 'transparent', color: 'white', borderRadius: '50px', padding: '5px 14px', fontSize: '12px', fontWeight: '700', cursor: 'pointer', transition: 'border-color 0.15s, transform 0.1s', flexShrink: 0, letterSpacing: '0.5px' },
  emptyQueue: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '64px 24px', color: '#b3b3b3', border: '1px dashed rgba(255,255,255,0.1)', borderRadius: '12px', gap: '12px' },
  queueNum: { color: '#b3b3b3', width: '20px', textAlign: 'center', fontSize: '14px', flexShrink: 0 },
  playerBar: { height: '90px', background: '#181818', borderTop: '1px solid #282828', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', flexShrink: 0 },
  nowPlayingWrap: { display: 'flex', alignItems: 'center', gap: '14px', width: '30%', minWidth: 0 },
  nowPlayingArt: { width: '56px', height: '56px', borderRadius: '4px', objectFit: 'cover', flexShrink: 0 },
  nowPlayingText: { minWidth: 0 },
  nowPlayingName: { fontWeight: '600', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  nowPlayingArtist: { color: '#b3b3b3', fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  controlsWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', width: '40%', maxWidth: '500px' },
  controlBtns: { display: 'flex', alignItems: 'center', gap: '20px', marginBottom: '8px' },
  playBtn: { width: '38px', height: '38px', borderRadius: '50%', background: 'white', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform 0.1s' },
  skipBtn: { background: 'transparent', border: 'none', color: '#b3b3b3', cursor: 'pointer', display: 'flex', alignItems: 'center', transition: 'color 0.15s' },
  progressRow: { display: 'flex', alignItems: 'center', gap: '10px', width: '100%', fontSize: '11px', color: '#b3b3b3' },
  progressTrack: { flex: 1, height: '4px', background: '#4d4d4d', borderRadius: '4px', overflow: 'hidden', cursor: 'pointer', position: 'relative' },
  progressFill: { height: '100%', background: 'white', borderRadius: '4px', transition: 'width 0.5s linear' },
  rightControls: { width: '30%', display: 'flex', justifyContent: 'flex-end', alignItems: 'center' },
  // Interaction overlay
  overlay: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, rgba(29,183,84,0.1) 0%, #121212 60%)' },
  overlayCard: { textAlign: 'center', padding: '48px 40px', background: '#181818', borderRadius: '16px', maxWidth: '440px', border: '1px solid rgba(255,255,255,0.05)', boxShadow: '0 24px 60px rgba(0,0,0,0.5)' },
  enterBtn: { background: '#1DB954', color: 'black', fontWeight: '700', padding: '14px 40px', borderRadius: '50px', border: 'none', cursor: 'pointer', fontSize: '16px', transition: 'transform 0.15s' },
};

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
  const [activeTab, setActiveTab] = useState('queue'); // 'queue' | 'search'

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

  // ─── Helper: load & play a video safely ────────────────────────────────────
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
      console.log('🎶 Track changed:', track?.name, '| youtubeId:', track?.youtubeId);
      setCurrentTrack(track);
      setProgress(0);
      setDuration(0);
      setIsPlaying(!!track);
      if (track?.youtubeId && hasInteractedRef.current) {
        loadAndPlay(track.youtubeId);
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

    return () => {
      socket.disconnect();
      clearInterval(progressIntervalRef.current);
    };
  }, [roomId, navigate, loadAndPlay]);

  // ─── Progress Interval ─────────────────────────────────────────────────────
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
    socketRef.current?.emit('add-track', { roomId, track });
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

  // ─── Shared sub-components ────────────────────────────────────────────────
  const TrackList = ({ tracks, isQueue }) => (
    <>
      {tracks.map((track, i) => (
        <div
          key={track.id + (isQueue ? 'q' : '')}
          style={{ display:'flex', alignItems:'center', padding:'10px 8px', borderRadius:'6px', gap:'12px', background: hoveredTrack === track.id+(isQueue?'q':'') ? 'rgba(255,255,255,0.07)' : 'transparent', cursor:'pointer' }}
          onMouseEnter={() => setHoveredTrack(track.id+(isQueue?'q':''))}
          onMouseLeave={() => setHoveredTrack(null)}
          onTouchStart={() => setHoveredTrack(track.id+(isQueue?'q':''))}
        >
          {isQueue && <span style={{ color:'#b3b3b3', width:'18px', fontSize:'13px', flexShrink:0 }}>{i+1}</span>}
          <img src={isQueue ? track.albumArt : (track.album?.images?.[2]?.url||'')} style={{ width:'42px', height:'42px', borderRadius:'4px', objectFit:'cover', flexShrink:0, background:'#333' }} alt="" onError={e=>e.currentTarget.style.background='#333'} />
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontWeight:'500', fontSize:'14px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{isQueue ? track.name : track.name}</div>
            <div style={{ color:'#b3b3b3', fontSize:'12px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{isQueue ? track.artist : track.artists?.[0]?.name}</div>
          </div>
          {!isQueue && (
            <button
              onClick={() => { handleAddTrack(track); if(isMobile) setActiveTab('queue'); }}
              style={{ flexShrink:0, border:'1px solid #b3b3b3', background:'transparent', color:'white', borderRadius:'50px', padding:'5px 12px', fontSize:'11px', fontWeight:'700', cursor:'pointer', opacity: hoveredTrack===track.id ? 1 : isMobile ? 1 : 0, transition:'opacity 0.15s' }}
            >ADD</button>
          )}
        </div>
      ))}
    </>
  );

  const PlayerBar = () => (
    <div style={{ background:'#181818', borderTop:'1px solid #282828', padding: isMobile ? '8px 12px' : '0 16px', height: isMobile ? 'auto' : '90px', display:'flex', flexDirection: isMobile ? 'column' : 'row', alignItems:'center', justifyContent:'space-between', gap: isMobile ? '8px' : 0, flexShrink:0 }}>
      {/* Track info */}
      <div style={{ display:'flex', alignItems:'center', gap:'10px', width: isMobile ? '100%' : '30%', minWidth:0 }}>
        {currentTrack ? (
          <>
            <img src={currentTrack.albumArt} style={{ width: isMobile ? '40px' : '56px', height: isMobile ? '40px' : '56px', borderRadius:'4px', objectFit:'cover', flexShrink:0 }} alt="" />
            <div style={{ minWidth:0, flex:1 }}>
              <div style={{ fontWeight:'600', fontSize: isMobile ? '13px' : '14px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{currentTrack.name}</div>
              <div style={{ color:'#b3b3b3', fontSize:'12px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{currentTrack.artist}</div>
            </div>
          </>
        ) : <div style={{ color:'#b3b3b3', fontSize:'13px' }}>Nothing playing yet</div>}
      </div>
      {/* Controls */}
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', width: isMobile ? '100%' : '40%' }}>
        <div style={{ display:'flex', alignItems:'center', gap:'20px', marginBottom:'6px' }}>
          <button onClick={togglePlay} disabled={!currentTrack} style={{ width:'38px', height:'38px', borderRadius:'50%', background:'white', border:'none', cursor: currentTrack?'pointer':'not-allowed', display:'flex', alignItems:'center', justifyContent:'center', opacity: currentTrack?1:0.4 }}>
            {isPlaying ? <Pause size={18} fill="black" color="black" /> : <Play size={18} fill="black" color="black" style={{ marginLeft:'2px' }} />}
          </button>
          <button onClick={handleSkip} disabled={!currentTrack} style={{ background:'transparent', border:'none', color:'#b3b3b3', cursor: currentTrack?'pointer':'not-allowed', display:'flex', alignItems:'center', opacity: currentTrack?1:0.4 }}>
            <SkipForward size={22} fill="currentColor" />
          </button>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:'8px', width:'100%', fontSize:'11px', color:'#b3b3b3' }}>
          <span style={{ minWidth:'32px', textAlign:'right' }}>{formatTime(progress)}</span>
          <div style={{ flex:1, height:'4px', background:'#4d4d4d', borderRadius:'4px', overflow:'hidden' }}>
            <div style={{ height:'100%', width:`${progressPct}%`, background: isPlaying?'#1DB954':'white', borderRadius:'4px', transition:'width 0.5s linear' }} />
          </div>
          <span style={{ minWidth:'32px' }}>{formatTime(duration)}</span>
        </div>
      </div>
      {/* Right */}
      {!isMobile && (
        <div style={{ width:'30%', display:'flex', justifyContent:'flex-end', alignItems:'center', color:'#b3b3b3', fontSize:'13px', gap:'6px' }}>
          <Users size={16} /><span>{userCount}</span>
        </div>
      )}
    </div>
  );

  const SearchPanel = () => (
    <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>
      <div style={{ padding: isMobile ? '12px 16px 8px' : '20px 24px 8px', flexShrink:0 }}>
        <div style={{ position:'relative', maxWidth: isMobile ? '100%' : '480px' }}>
          <span style={{ position:'absolute', left:'16px', top:'50%', transform:'translateY(-50%)', color:'#b3b3b3', pointerEvents:'none' }}><Search size={18} /></span>
          <input
            type="text" value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search for songs or artists..."
            autoFocus={isMobile}
            style={{ width:'100%', background:'#242424', border:'none', borderRadius:'50px', color:'white', padding:'12px 20px 12px 48px', fontSize:'14px', outline:'none', boxSizing:'border-box' }}
            onFocus={e => e.currentTarget.style.background='#333'}
            onBlur={e => e.currentTarget.style.background='#242424'}
          />
        </div>
      </div>
      <div style={{ flex:1, overflowY:'auto', padding: isMobile ? '8px 16px 16px' : '8px 24px 24px' }}>
        {isSearching && <p style={{ color:'#b3b3b3', padding:'16px 8px' }}>Searching Spotify...</p>}
        {!isSearching && searchTerm && searchResults.length === 0 && <p style={{ color:'#b3b3b3', padding:'16px 8px' }}>No results found.</p>}
        {searchResults.length > 0 && <TrackList tracks={searchResults} isQueue={false} />}
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

  const QueuePanel = () => (
    <div style={{ flex:1, overflowY:'auto', padding: isMobile ? '16px' : '16px 24px 24px' }}>
      <p style={{ fontSize: isMobile ? '18px' : '22px', fontWeight:'800', marginBottom:'16px' }}>Up Next</p>
      {queue.length === 0 ? (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'48px 24px', color:'#b3b3b3', border:'1px dashed rgba(255,255,255,0.1)', borderRadius:'12px', gap:'12px' }}>
          <ListMusic size={48} style={{ opacity:0.3 }} />
          <p style={{ fontWeight:'600' }}>Queue is empty</p>
          <p style={{ fontSize:'13px' }}>Search for a song to start the jam!</p>
        </div>
      ) : <TrackList tracks={queue} isQueue={true} />}
    </div>
  );

  // ─── Main Room UI ─────────────────────────────────────────────────────────
  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', width:'100vw', overflow:'hidden', backgroundColor:'#121212', color:'white' }}>
      {/* Hidden YouTube Player */}
      <div style={{ position:'absolute', left:'-9999px', top:'-9999px', width:'300px', height:'300px', pointerEvents:'none' }}>
        <div id="yt-player-container"></div>
      </div>

      {!hasInteracted ? (
        <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', background:'linear-gradient(135deg, rgba(29,183,84,0.1) 0%, #121212 60%)', padding:'20px' }}>
          <div style={{ textAlign:'center', padding:'48px 32px', background:'#181818', borderRadius:'16px', maxWidth:'400px', width:'100%', border:'1px solid rgba(255,255,255,0.05)', boxShadow:'0 24px 60px rgba(0,0,0,0.5)' }}>
            <div style={{ display:'flex', justifyContent:'center', marginBottom:'24px' }}>
              <div style={{ width:'72px', height:'72px', background:'#1DB954', borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 0 40px rgba(29,185,84,0.4)' }}>
                <Music size={36} color="black" />
              </div>
            </div>
            <h2 style={{ fontSize:'24px', fontWeight:'800', marginBottom:'10px' }}>Ready to join the Jam?</h2>
            <p style={{ color:'#b3b3b3', marginBottom:'28px', lineHeight:'1.6', fontSize:'14px' }}>
              Room <strong style={{ color:'#1DB954', fontFamily:'monospace', letterSpacing:'2px' }}>{roomId}</strong><br />
              Click below so your browser allows audio to play.
            </p>
            <button onClick={handleEnterRoom} style={{ background:'#1DB954', color:'black', fontWeight:'700', padding:'14px 40px', borderRadius:'50px', border:'none', cursor:'pointer', fontSize:'16px', width:'100%' }}>
              Enter the Jam 🎵
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
          <div style={{ display:'flex', background:'#181818', borderBottom:'1px solid #282828', flexShrink:0 }}>
            {[['search','🔍 Search'],['queue','📋 Queue']].map(([tab, label]) => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{ flex:1, padding:'12px', border:'none', background:'transparent', color: activeTab===tab ? '#1DB954' : '#b3b3b3', fontWeight: activeTab===tab ? '700' : '400', fontSize:'14px', cursor:'pointer', borderBottom: activeTab===tab ? '2px solid #1DB954' : '2px solid transparent', transition:'all 0.15s' }}>
                {label}
              </button>
            ))}
          </div>

          {/* Mobile Tab Content */}
          <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}>
            {activeTab === 'search' ? <SearchPanel /> : <QueuePanel />}
          </div>

          {/* Mobile Player Bar */}
          <PlayerBar />
        </>
      ) : (
        /* ── DESKTOP LAYOUT ── */
        <>
          <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
            {/* Sidebar */}
            <div style={{ width:'240px', background:'#000', padding:'24px 16px', display:'flex', flexDirection:'column', flexShrink:0 }}>
              <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'32px', paddingLeft:'8px' }}>
                <Music color="#1DB954" size={28} />
                <span style={{ fontSize:'20px', fontWeight:'800' }}>YourJam</span>
              </div>
              <div style={{ marginBottom:'24px' }}>
                <p style={S.sectionLabel}>Your Room</p>
                <div style={S.roomCard}>
                  <div style={S.roomCodeLabel}>Room Code</div>
                  <div style={S.roomCodeRow}>
                    <span style={S.roomCode}>{roomId}</span>
                    <button onClick={copyRoomCode} style={{ background:'transparent', border:'none', cursor:'pointer', color:'#b3b3b3', display:'flex' }}>
                      {copied ? <CheckCircle2 size={18} color="#1DB954" /> : <Copy size={18} color="#b3b3b3" />}
                    </button>
                  </div>
                </div>
                <div style={S.userCount}><Users size={15} /><span>{userCount} listener{userCount!==1?'s':''}</span></div>
              </div>
              {currentTrack && (
                <div style={{ marginTop:'auto' }}>
                  <p style={S.sectionLabel}>Now Playing</p>
                  <div style={{ borderRadius:'8px', overflow:'hidden', boxShadow:'0 8px 24px rgba(0,0,0,0.5)' }}>
                    <img src={currentTrack.albumArt} alt="" style={{ width:'100%', aspectRatio:'1', objectFit:'cover', display:'block' }} />
                  </div>
                  <p style={{ fontWeight:'700', marginTop:'12px', fontSize:'14px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{currentTrack.name}</p>
                  <p style={{ color:'#b3b3b3', fontSize:'13px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{currentTrack.artist}</p>
                </div>
              )}
            </div>
            {/* Center Area */}
            <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:'linear-gradient(180deg, #2a2a2a 0%, #121212 300px)' }}>
              <SearchPanel />
              {!searchTerm && <QueuePanel />}
            </div>
          </div>
          <PlayerBar />
        </>
      )}
    </div>
  );
}

