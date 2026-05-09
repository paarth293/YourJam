const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const SpotifyWebApi = require('spotify-web-api-node');
const axios = require('axios');
const dotenv = require('dotenv');
const fs = require('fs');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- SPOTIFY SETUP ---
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

async function retrieveSpotifyToken() {
  try {
    const data = await spotifyApi.clientCredentialsGrant();
    console.log('Spotify access token expires in ' + data.body['expires_in']);
    spotifyApi.setAccessToken(data.body['access_token']);
  } catch (err) {
    console.error('Something went wrong when retrieving Spotify access token', err.message);
  }
}

if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
  retrieveSpotifyToken();
  setInterval(retrieveSpotifyToken, 1000 * 60 * 50); // Refresh every 50 mins
} else {
  console.log("Missing Spotify credentials. Please set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env");
}

// --- YOUTUBE CACHING & ROTATION ---
const CACHE_FILE = './youtube_cache.json';
let youtubeCache = {};
if (fs.existsSync(CACHE_FILE)) {
  try {
    youtubeCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    console.error("Error reading cache file:", e);
  }
}

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(youtubeCache, null, 2));
}

let youtubeApiKeys = (process.env.YOUTUBE_API_KEYS || "").split(',').map(k => k.trim()).filter(k => k);
let currentKeyIndex = 0;

async function getYoutubeId(trackName, artistName) {
  const cacheKey = `${trackName} ${artistName}`.toLowerCase();
  if (youtubeCache[cacheKey]) {
    console.log("Cache hit for:", cacheKey);
    return youtubeCache[cacheKey];
  }

  const query = `${trackName} ${artistName} official audio`;
  
  while (currentKeyIndex < youtubeApiKeys.length) {
    const key = youtubeApiKeys[currentKeyIndex];
    try {
      console.log("Searching YouTube with key index:", currentKeyIndex);
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&key=${key}&maxResults=1&type=video`;
      const response = await axios.get(url);
      
      if (response.data.items && response.data.items.length > 0) {
        const videoId = response.data.items[0].id.videoId;
        youtubeCache[cacheKey] = videoId;
        saveCache();
        return videoId;
      } else {
        return null;
      }
    } catch (error) {
      if (error.response && error.response.status === 403) {
        console.log("Quota exceeded for key index", currentKeyIndex, "- switching key...");
        currentKeyIndex++;
      } else {
        console.error("YouTube search error:", error.message);
        return null; 
      }
    }
  }
  
  console.error("All YouTube API keys exhausted or none provided!");
  return null;
}

// --- REST API ROUTES ---
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query is required' });
  if (!spotifyApi.getAccessToken()) return res.status(500).json({ error: 'Spotify not initialized' });

  try {
    const data = await spotifyApi.searchTracks(q, { limit: 10 });
    res.json(data.body.tracks.items);
  } catch (error) {
    console.error("Spotify search error:", error);
    res.status(500).json({ error: 'Spotify search failed' });
  }
});

// --- SOCKET.IO ROOMS LOGIC ---
const rooms = new Map(); // roomId -> { users, queue, currentTrack, currentTime, isPlaying }

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('create-room', () => {
    const roomId = generateRoomId();
    rooms.set(roomId, {
      users: new Set([socket.id]),
      queue: [],
      currentTrack: null,
      currentTime: 0,
      isPlaying: false
    });
    socket.join(roomId);
    socket.emit('room-created', { roomId });
  });

  socket.on('join-room', ({ roomId }) => {
    roomId = roomId.toUpperCase();
    const room = rooms.get(roomId);
    if (room) {
      socket.join(roomId);
      room.users.add(socket.id);
      
      // Sync state to the new user immediately
      socket.emit('sync-state', {
        queue: room.queue,
        currentTrack: room.currentTrack,
        currentTime: room.currentTime,
        isPlaying: room.isPlaying
      });
      
      socket.to(roomId).emit('user-joined', { count: room.users.size });
    } else {
      socket.emit('error', { message: 'Room not found' });
    }
  });

  socket.on('add-track', async ({ roomId, track }) => {
    roomId = roomId.toUpperCase();
    const room = rooms.get(roomId);
    if (room) {
      const artistName = track.artists && track.artists.length > 0 ? track.artists[0].name : '';
      const youtubeId = await getYoutubeId(track.name, artistName);
      
      const trackToAdd = {
        id: track.id + '-' + Date.now(), // Ensure unique ID in queue
        spotifyId: track.id,
        name: track.name,
        artist: artistName,
        albumArt: track.album && track.album.images ? track.album.images[0].url : '',
        youtubeId: youtubeId
      };
      
      room.queue.push(trackToAdd);
      
      // If nothing is playing, start immediately
      if (!room.currentTrack) {
         room.currentTrack = room.queue.shift();
         room.isPlaying = true;
         io.in(roomId).emit('track-changed', room.currentTrack);
      }
      
      io.in(roomId).emit('update-queue', room.queue);
    }
  });

  socket.on('play', (roomId) => {
    const room = rooms.get(roomId);
    if (room) {
      room.isPlaying = true;
      io.in(roomId).emit('play');   // broadcast to ALL users including sender
    }
  });

  socket.on('pause', (roomId) => {
    const room = rooms.get(roomId);
    if (room) {
      room.isPlaying = false;
      io.in(roomId).emit('pause');  // broadcast to ALL users including sender
    }
  });

  socket.on('seek', ({ roomId, time }) => {
    const room = rooms.get(roomId);
    if (room) {
      room.currentTime = time;
      io.in(roomId).emit('seek', time);  // broadcast to ALL users including sender
    }
  });
  
  socket.on('sync-time', ({ roomId, time }) => {
    // Allows host to update current time on server
    const room = rooms.get(roomId);
    if (room) {
      room.currentTime = time;
    }
  });

  socket.on('skip', (roomId) => {
    const room = rooms.get(roomId);
    if (room) {
      if (room.queue.length > 0) {
        room.currentTrack = room.queue.shift();
        room.currentTime = 0;
        room.isPlaying = true;
        io.in(roomId).emit('track-changed', room.currentTrack);
        io.in(roomId).emit('update-queue', room.queue);
      } else {
        room.currentTrack = null;
        room.currentTime = 0;
        room.isPlaying = false;
        io.in(roomId).emit('track-changed', null);
      }
    }
  });

  socket.on('disconnect', () => {
    for (const [roomId, room] of rooms.entries()) {
      if (room.users.has(socket.id)) {
        room.users.delete(socket.id);
        io.in(roomId).emit('user-left', { count: room.users.size });
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
