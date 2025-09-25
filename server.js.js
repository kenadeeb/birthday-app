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
app.use(express.json({ limit: '50mb' })); // Increase limit for file data
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://username:password@cluster0.xxxxx.mongodb.net/birthday-app?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => {
  console.log('✅ Connected to MongoDB successfully!');
  startCleanupJob();
})
.catch(err => console.error('❌ MongoDB connection error:', err));

// Enhanced Message Schema with file support
const messageSchema = new mongoose.Schema({
  text: String,
  sender: String,
  timestamp: { type: Date, default: Date.now },
  isFile: Boolean,
  files: [{
    name: String,
    size: Number,
    type: String,
    data: String, // Base64 encoded file data
    url: String
  }],
  expiresAt: { type: Date, required: true }
});

// Create TTL index for automatic expiration
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Message = mongoose.model('Message', messageSchema);

// Auto-delete job
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
  }, 30 * 60 * 1000);
}

// API Routes
app.get('/', (req, res) => {
  res.json({ 
    message: 'Birthday App API is running!',
    version: '2.0',
    features: ['real-time messaging', 'file uploads', 'auto-delete']
  });
});

app.get('/api/messages', async (req, res) => {
  try {
    const messages = await Message.find({
      expiresAt: { $gt: new Date() }
    }).sort({ timestamp: -1 }).limit(50);
    
    // Convert base64 data to URLs for frontend
    const messagesWithUrls = messages.map(msg => ({
      ...msg.toObject(),
      files: msg.files.map(file => ({
        ...file,
        url: file.data ? `data:${file.type};base64,${file.data}` : file.url
      }))
    }));
    
    res.json(messagesWithUrls.reverse());
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.post('/api/messages', async (req, res) => {
  try {
    const { text, sender, isFile, files } = req.body;
    
    // Process files - convert to base64 if they contain file data
    const processedFiles = await Promise.all(
      (files || []).map(async (file) => {
        if (file.data && file.data.startsWith('data:')) {
          // Extract base64 data from data URL
          const base64Data = file.data.split(',')[1];
          return {
            name: file.name,
            size: file.size,
            type: file.type,
            data: base64Data,
            url: file.data
          };
        }
        return file;
      })
    );
    
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    
    const message = new Message({ 
      text, 
      sender, 
      isFile, 
      files: processedFiles,
      expiresAt 
    });
    
    await message.save();
    
    // Emit to all connected clients
    io.emit('newMessage', {
      ...message.toObject(),
      files: message.files.map(file => ({
        ...file,
        url: file.data ? `data:${file.type};base64,${file.data}` : file.url
      }))
    });
    
    res.status(201).json(message);
  } catch (error) {
    console.error('Error saving message:', error);
    res.status(500).json({ error: 'Failed to save message' });
  }
});

// Socket.io for real-time communication
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('sendMessage', async (data) => {
    try {
      // Process files for base64 conversion
      const processedFiles = await Promise.all(
        (data.files || []).map(async (file) => {
          if (file.data && file.data.startsWith('data:')) {
            const base64Data = file.data.split(',')[1];
            return {
              ...file,
              data: base64Data,
              url: file.data
            };
          }
          return file;
        })
      );
      
      const messageData = {
        ...data,
        files: processedFiles,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000)
      };
      
      const message = new Message(messageData);
      await message.save();
      
      // Broadcast to all clients
      io.emit('newMessage', {
        ...message.toObject(),
        files: message.files.map(file => ({
          ...file,
          url: file.data ? `data:${file.type};base64,${file.data}` : file.url
        }))
      });
      
      console.log('📨 Message sent:', { 
        sender: data.sender, 
        hasFiles: data.files?.length > 0,
        fileCount: data.files?.length || 0 
      });
    } catch (error) {
      console.error('Error saving message via socket:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('📁 File upload support: ENABLED');
  console.log('⏰ Auto-delete: ENABLED (2 hours)');
  console.log(`🔗 API URL: http://localhost:${PORT}`);
});
