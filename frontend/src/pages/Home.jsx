import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import { Music, ArrowRight, Sparkles, Radio } from 'lucide-react';

const SOCKET_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

export default function Home() {
  const [roomCode, setRoomCode] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleCreateRoom = () => {
    setIsCreating(true);
    setError('');
    const socket = io(SOCKET_URL);
    socket.emit('create-room');
    socket.on('room-created', ({ roomId }) => {
      socket.disconnect();
      navigate(`/room/${roomId}`);
    });
    socket.on('connect_error', () => {
      setIsCreating(false);
      setError('Cannot connect to server. Please try again.');
    });
    setTimeout(() => {
      if (isCreating) {
        setIsCreating(false);
        setError('Server took too long. Try again in a moment.');
      }
    }, 8000);
  };

  const handleJoinRoom = (e) => {
    e.preventDefault();
    const code = roomCode.trim().toUpperCase();
    if (code.length < 4) { setError('Please enter a valid room code.'); return; }
    navigate(`/room/${code}`);
  };

  return (
    <div className="grid-bg" style={{
      flex:1, display:'flex', alignItems:'center', justifyContent:'center',
      background:'#060612', padding:'20px', position:'relative', overflow:'hidden',
      minHeight:'100vh',
    }}>
      {/* Floating ambient orbs */}
      <div style={{ position:'absolute', width:'500px', height:'500px', borderRadius:'50%', background:'radial-gradient(circle, rgba(29,185,84,0.1) 0%, transparent 70%)', top:'-100px', left:'-100px', pointerEvents:'none' }} />
      <div style={{ position:'absolute', width:'400px', height:'400px', borderRadius:'50%', background:'radial-gradient(circle, rgba(100,60,200,0.08) 0%, transparent 70%)', bottom:'-80px', right:'-80px', pointerEvents:'none' }} />
      <div style={{ position:'absolute', width:'300px', height:'300px', borderRadius:'50%', background:'radial-gradient(circle, rgba(255,100,150,0.06) 0%, transparent 70%)', top:'40%', right:'20%', pointerEvents:'none' }} />

      {/* Main card */}
      <div className="glass" style={{
        padding:'44px 40px', borderRadius:'28px',
        width:'100%', maxWidth:'420px', textAlign:'center',
        boxShadow:'0 32px 80px rgba(0,0,0,0.7)',
        border:'1px solid rgba(255,255,255,0.08)',
        position:'relative',
      }}>
        {/* Animated logo */}
        <div style={{ display:'flex', justifyContent:'center', marginBottom:'24px' }}>
          <div style={{
            width:'84px', height:'84px',
            background:'linear-gradient(135deg, #1DB954, #17a348)',
            borderRadius:'24px',
            display:'flex', alignItems:'center', justifyContent:'center',
            boxShadow:'0 0 50px rgba(29,185,84,0.55)',
            animation:'pulse-glow 2.5s ease-in-out infinite',
          }}>
            <Music size={40} color="black" />
          </div>
        </div>

        <h1 style={{ fontSize:'38px', fontWeight:'900', marginBottom:'6px', letterSpacing:'-1.5px', background:'linear-gradient(135deg, #fff 40%, rgba(255,255,255,0.6))', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>
          YourJam
        </h1>
        <p style={{ color:'rgba(255,255,255,0.4)', marginBottom:'36px', fontSize:'14px', lineHeight:'1.6' }}>
          Listen together, perfectly synced ✨<br/>
          <span style={{ color:'rgba(29,185,84,0.8)', fontSize:'13px' }}>Every beat, shared in real time.</span>
        </p>

        {/* Create room button */}
        <button
          onClick={handleCreateRoom}
          disabled={isCreating}
          style={{
            width:'100%',
            background: isCreating ? 'rgba(29,185,84,0.5)' : '#1DB954',
            color:'black', fontWeight:'800',
            padding:'15px', borderRadius:'14px',
            border:'none', cursor: isCreating ? 'not-allowed' : 'pointer',
            fontSize:'15px', letterSpacing:'0.3px',
            display:'flex', alignItems:'center', justifyContent:'center', gap:'8px',
            marginBottom:'20px',
            transition:'transform 0.15s, box-shadow 0.15s',
            boxShadow:'0 0 24px rgba(29,185,84,0.35)',
          }}
          onMouseEnter={e => { if(!isCreating){e.currentTarget.style.transform='scale(1.02)';e.currentTarget.style.boxShadow='0 0 40px rgba(29,185,84,0.55)';} }}
          onMouseLeave={e => { e.currentTarget.style.transform='scale(1)';e.currentTarget.style.boxShadow='0 0 24px rgba(29,185,84,0.35)'; }}
        >
          {isCreating ? (
            <>
              <div style={{ width:'18px', height:'18px', border:'2px solid rgba(0,0,0,0.3)', borderTop:'2px solid black', borderRadius:'50%', animation:'vinyl-spin 0.7s linear infinite' }} />
              Connecting...
            </>
          ) : (
            <>
              <Radio size={18} />
              Start a New Jam
            </>
          )}
        </button>

        {/* Divider */}
        <div style={{ display:'flex', alignItems:'center', gap:'12px', marginBottom:'20px' }}>
          <div style={{ flex:1, height:'1px', background:'rgba(255,255,255,0.08)' }} />
          <span style={{ color:'rgba(255,255,255,0.25)', fontSize:'12px', letterSpacing:'1px' }}>OR JOIN</span>
          <div style={{ flex:1, height:'1px', background:'rgba(255,255,255,0.08)' }} />
        </div>

        {/* Join room form */}
        <form onSubmit={handleJoinRoom} style={{ position:'relative' }}>
          <input
            type="text"
            value={roomCode}
            onChange={e => { setRoomCode(e.target.value.toUpperCase()); setError(''); }}
            placeholder="ROOM CODE"
            maxLength={8}
            style={{
              width:'100%', boxSizing:'border-box',
              background:'rgba(255,255,255,0.06)',
              border:'1px solid rgba(255,255,255,0.1)',
              color:'white', padding:'14px 52px 14px 20px',
              borderRadius:'14px', outline:'none',
              fontSize:'22px', fontFamily:'monospace',
              letterSpacing:'8px', textAlign:'center',
              transition:'border-color 0.2s, background 0.2s',
              fontWeight:'800',
            }}
            onFocus={e => { e.currentTarget.style.borderColor='rgba(29,185,84,0.5)'; e.currentTarget.style.background='rgba(255,255,255,0.09)'; }}
            onBlur={e =>  { e.currentTarget.style.borderColor='rgba(255,255,255,0.1)'; e.currentTarget.style.background='rgba(255,255,255,0.06)'; }}
          />
          {roomCode.length >= 4 && (
            <button type="submit" style={{
              position:'absolute', right:'8px', top:'50%', transform:'translateY(-50%)',
              background:'#1DB954', color:'black', border:'none',
              borderRadius:'10px', width:'38px', height:'38px', cursor:'pointer',
              display:'flex', alignItems:'center', justifyContent:'center',
              transition:'transform 0.15s',
            }}
              onMouseEnter={e => e.currentTarget.style.transform='translateY(-50%) scale(1.1)'}
              onMouseLeave={e => e.currentTarget.style.transform='translateY(-50%) scale(1)'}
            >
              <ArrowRight size={18} />
            </button>
          )}
        </form>

        {/* Error */}
        {error && (
          <p style={{ marginTop:'14px', color:'#ff6b6b', fontSize:'13px', background:'rgba(255,100,100,0.08)', border:'1px solid rgba(255,100,100,0.2)', borderRadius:'8px', padding:'8px 12px' }}>
            {error}
          </p>
        )}

        {/* Footer hint */}
        <p style={{ marginTop:'28px', color:'rgba(255,255,255,0.18)', fontSize:'12px', display:'flex', alignItems:'center', justifyContent:'center', gap:'6px' }}>
          <Sparkles size={12} />
          Share the room code with a friend to jam together
        </p>
      </div>
    </div>
  );
}
