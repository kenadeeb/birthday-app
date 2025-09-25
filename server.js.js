const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://username:password@cluster0.xxxxx.mongodb.net/birthday-app?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => {
  console.log('✅ Connected to MongoDB successfully!');
  startCleanupJob(); // Start the auto-delete job
})
.catch(err => console.error('❌ MongoDB connection error:', err));

// Enhanced Message Schema with expiration
const messageSchema = new mongoose.Schema({
  text: String,
  sender: String,
  timestamp: { type: Date, default: Date.now },
  isFile: Boolean,
  files: [{
    name: String,
    size: Number,
    type: String,
    url: String
  }],
  expiresAt: { type: Date, required: true }
});

// Create TTL index for automatic expiration (2 hours)
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Message = mongoose.model('Message', messageSchema);

// Auto-delete job (runs every 30 minutes)
function startCleanupJob() {
  setInterval(async () => {
    try {
      const result = await Message.deleteMany({
        expiresAt: { $lt: new Date() }
      });
      if (result.deletedCount > 0) {
        console.log(`🧹 Cleaned up ${result.deletedCount} expired messages`);
      }
    } catch (error) {
      console.error('Error cleaning up messages:', error);
    }
  }, 30 * 60 * 1000); // 30 minutes
}

// API Routes
app.get('/api/messages', async (req, res) => {
  try {
    // Only get messages that haven't expired
    const messages = await Message.find({
      expiresAt: { $gt: new Date() }
    }).sort({ timestamp: -1 }).limit(50);
    res.json(messages.reverse());
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.post('/api/messages', async (req, res) => {
  try {
    const { text, sender, isFile, files } = req.body;
    
    // Set expiration to 2 hours from now
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    
    const message = new Message({ 
      text, 
      sender, 
      isFile, 
      files,
      expiresAt 
    });
    
    await message.save();
    
    io.emit('newMessage', message);
    res.status(201).json(message);
  } catch (error) {
    res.status(500).json({ error: 'Failed to save message' });
  }
});

// Delete specific message
app.delete('/api/messages/:id', async (req, res) => {
  try {
    await Message.findByIdAndDelete(req.params.id);
    io.emit('messageDeleted', req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Socket.io for real-time communication
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('sendMessage', async (data) => {
    try {
      // Set expiration to 2 hours from now
      data.expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
      
      const message = new Message(data);
      await message.save();
      io.emit('newMessage', message);
    } catch (error) {
      console.error('Error saving message:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('⏰ Auto-delete enabled: Messages will be deleted after 2 hours');
});
