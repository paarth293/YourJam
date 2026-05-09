import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import { Music, ArrowRight, PlayCircle } from 'lucide-react';

const SOCKET_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

export default function Home() {
  const [roomCode, setRoomCode] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const navigate = useNavigate();

  const handleCreateRoom = () => {
    setIsCreating(true);
    const socket = io(SOCKET_URL);
    socket.emit('create-room');
    socket.on('room-created', ({ roomId }) => {
      socket.disconnect();
      navigate(`/room/${roomId}`);
    });
    socket.on('connect_error', () => {
      setIsCreating(false);
      alert('Cannot connect to server. Is the backend running?');
    });
  };

  const handleJoinRoom = (e) => {
    e.preventDefault();
    if (roomCode.trim()) {
      navigate(`/room/${roomCode.trim().toUpperCase()}`);
    }
  };

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, rgba(29,183,84,0.12) 0%, #121212 60%)',
      padding: '20px'
    }}>
      <div style={{
        background: '#181818',
        padding: '40px',
        borderRadius: '16px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        width: '100%',
        maxWidth: '420px',
        textAlign: 'center',
        border: '1px solid rgba(255,255,255,0.05)'
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '24px' }}>
          <div style={{
            width: '80px', height: '80px',
            background: '#1DB954',
            borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 40px rgba(29,185,84,0.4)'
          }}>
            <Music size={40} color="black" />
          </div>
        </div>

        <h1 style={{ fontSize: '36px', fontWeight: '800', marginBottom: '8px', letterSpacing: '-0.5px' }}>YourJam</h1>
        <p style={{ color: '#b3b3b3', marginBottom: '36px', fontSize: '15px' }}>Listen together, perfectly synced.</p>

        <button
          onClick={handleCreateRoom}
          disabled={isCreating}
          style={{
            width: '100%',
            background: '#1DB954',
            color: 'black',
            fontWeight: '700',
            padding: '16px',
            borderRadius: '50px',
            border: 'none',
            cursor: isCreating ? 'not-allowed' : 'pointer',
            fontSize: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            marginBottom: '28px',
            transition: 'transform 0.15s, background 0.15s',
            opacity: isCreating ? 0.7 : 1
          }}
          onMouseEnter={e => { if (!isCreating) e.currentTarget.style.transform = 'scale(1.03)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
        >
          <PlayCircle size={22} />
          {isCreating ? 'Connecting...' : 'Start a New Jam'}
        </button>

        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px' }}>
          <div style={{ position: 'absolute', borderTop: '1px solid rgba(255,255,255,0.1)', width: '100%' }}></div>
          <span style={{ background: '#181818', padding: '0 16px', color: '#b3b3b3', fontSize: '13px', position: 'relative' }}>or join existing</span>
        </div>

        <form onSubmit={handleJoinRoom} style={{ position: 'relative' }}>
          <input
            type="text"
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
            placeholder="Enter Room Code"
            maxLength={6}
            style={{
              width: '100%',
              background: '#2a2a2a',
              border: '2px solid transparent',
              color: 'white',
              padding: '14px 48px 14px 20px',
              borderRadius: '50px',
              outline: 'none',
              fontSize: '20px',
              fontFamily: 'monospace',
              letterSpacing: '6px',
              textAlign: 'center',
              transition: 'border-color 0.2s',
              boxSizing: 'border-box'
            }}
            onFocus={e => e.currentTarget.style.borderColor = '#1DB954'}
            onBlur={e => e.currentTarget.style.borderColor = 'transparent'}
          />
          {roomCode.length > 0 && (
            <button type="submit" style={{
              position: 'absolute', right: '6px', top: '6px', bottom: '6px',
              background: 'white', color: 'black', border: 'none',
              borderRadius: '50%', width: '40px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s'
            }}>
              <ArrowRight size={20} />
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
