const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Enhanced CORS configuration
const io = socketIo(server, {
  cors: {
    origin: "*", // Allow all origins in production
    methods: ["GET", "POST", "DELETE"],
    credentials: true
  }
});

// Middleware with increased limits for file uploads
app.use(cors({
  origin: "*",
  credentials: true
}));
app.use(express.json({ limit: '50mb' })); // Increased for base64 files
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// MongoDB connection with better error handling
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://username:password@cluster0.xxxxx.mongodb.net/birthday-app?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
.then(() => {
  console.log('✅ Connected to MongoDB successfully!');
  startCleanupJob();
})
.catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

// Enhanced Message Schema with file support and validation
const messageSchema = new mongoose.Schema({
  text: {
    type: String,
    required: function() {
      return !this.isFile || this.files.length === 0;
    },
    maxlength: 5000
  },
  sender: {
    type: String,
    required: true,
    enum: ['Rafat Fatima', 'Adeeb'] // Only allow these senders
  },
  timestamp: { 
    type: Date, 
    default: Date.now 
  },
  isFile: {
    type: Boolean,
    default: false
  },
  files: [{
    name: {
      type: String,
      required: true
    },
    size: {
      type: Number,
      required: true,
      min: 0,
      max: 10485760 // 10MB limit
    },
    type: {
      type: String,
      required: true
    },
    data: {
      type: String, // Base64 encoded file data
      required: function() {
        return this.url === undefined;
      }
    },
    url: {
      type: String
    }
  }],
  expiresAt: { 
    type: Date, 
    required: true,
    index: true 
  }
});

// Create TTL index for automatic expiration (2 hours)
messageSchema.index({ expiresAt: 1 }, { 
  expireAfterSeconds: 0,
  background: true 
});

// Add virtual for formatted timestamp
messageSchema.virtual('formattedTime').get(function() {
  return this.timestamp.toLocaleString();
});

const Message = mongoose.model('Message', messageSchema);

// Auto-delete job with better error handling
function startCleanupJob() {
  console.log('🕒 Starting auto-cleanup job (runs every 30 minutes)');
  
  setInterval(async () => {
    try {
      const cutoffTime = new Date();
      const result = await Message.deleteMany({
        expiresAt: { $lt: cutoffTime }
      });
      
      if (result.deletedCount > 0) {
        console.log(`🧹 Cleaned up ${result.deletedCount} expired messages`);
      }
    } catch (error) {
      console.error('❌ Error cleaning up messages:', error);
    }
  }, 30 * 60 * 1000); // 30 minutes
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    mongodb: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: '🎉 Birthday App API is running!',
    version: '2.0.0',
    features: [
      'Real-time messaging',
      'File uploads with preview',
      'Auto-delete after 2 hours',
      'REST API & WebSocket support'
    ],
    endpoints: {
      health: '/health',
      messages: {
        get: '/api/messages',
        post: '/api/messages',
        delete: '/api/messages/:id'
      }
    },
    documentation: 'See README for usage instructions'
  });
});

// API Routes with enhanced error handling
app.get('/api/messages', async (req, res) => {
  try {
    const messages = await Message.find({
      expiresAt: { $gt: new Date() }
    })
    .sort({ timestamp: -1 })
    .limit(50)
    .lean(); // Convert to plain objects
    
    // Convert base64 data to data URLs for frontend
    const messagesWithUrls = messages.map(msg => ({
      ...msg,
      files: msg.files ? msg.files.map(file => ({
        ...file,
        url: file.data ? `data:${file.type};base64,${file.data}` : file.url
      })) : []
    }));
    
    res.json({
      success: true,
      count: messagesWithUrls.length,
      messages: messagesWithUrls.reverse()
    });
  } catch (error) {
    console.error('❌ Error fetching messages:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch messages',
      details: error.message 
    });
  }
});

app.post('/api/messages', async (req, res) => {
  try {
    const { text, sender, isFile, files } = req.body;
    
    // Validation
    if (!sender || !['Rafat Fatima', 'Adeeb'].includes(sender)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid sender. Must be "Rafat Fatima" or "Adeeb"'
      });
    }
    
    if (!text && (!isFile || !files || files.length === 0)) {
      return res.status(400).json({
        success: false,
        error: 'Message text or file is required'
      });
    }
    
    // Process files - convert to base64 if they contain file data
    const processedFiles = await Promise.all(
      (files || []).map(async (file) => {
        if (file.data && file.data.startsWith('data:')) {
          // Extract base64 data from data URL
          const base64Data = file.data.split(',')[1];
          return {
            name: file.name || 'unknown',
            size: file.size || 0,
            type: file.type || 'application/octet-stream',
            data: base64Data,
            url: file.data
          };
        }
        return {
          name: file.name || 'unknown',
          size: file.size || 0,
          type: file.type || 'application/octet-stream',
          url: file.url
        };
      })
    );
    
    // Set expiration to 2 hours from now
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    
    const message = new Message({ 
      text: text || (isFile ? `File: ${processedFiles[0]?.name}` : ''),
      sender, 
      isFile: !!isFile, 
      files: processedFiles,
      expiresAt 
    });
    
    await message.save();
    
    // Prepare message for broadcasting (convert base64 to URLs)
    const broadcastMessage = {
      ...message.toObject(),
      files: message.files.map(file => ({
        ...file,
        url: file.data ? `data:${file.type};base64,${file.data}` : file.url
      }))
    };
    
    // Emit to all connected clients
    io.emit('newMessage', broadcastMessage);
    
    console.log(`📨 New message from ${sender}:`, {
      hasFiles: isFile,
      fileCount: processedFiles.length,
      messageId: message._id
    });
    
    res.status(201).json({
      success: true,
      message: broadcastMessage
    });
  } catch (error) {
    console.error('❌ Error saving message:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to save message',
      details: error.message 
    });
  }
});

// Delete specific message
app.delete('/api/messages/:id', async (req, res) => {
  try {
    const message = await Message.findByIdAndDelete(req.params.id);
    
    if (!message) {
      return res.status(404).json({
        success: false,
        error: 'Message not found'
      });
    }
    
    io.emit('messageDeleted', req.params.id);
    
    res.json({ 
      success: true,
      message: 'Message deleted successfully'
    });
  } catch (error) {
    console.error('❌ Error deleting message:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete message',
      details: error.message 
    });
  }
});

// Get message by ID
app.get('/api/messages/:id', async (req, res) => {
  try {
    const message = await Message.findById(req.params.id);
    
    if (!message) {
      return res.status(404).json({
        success: false,
        error: 'Message not found'
      });
    }
    
    if (message.expiresAt < new Date()) {
      return res.status(410).json({
        success: false,
        error: 'Message has expired'
      });
    }
    
    // Convert base64 to URL
    const messageWithUrl = {
      ...message.toObject(),
      files: message.files.map(file => ({
        ...file,
        url: file.data ? `data:${file.type};base64,${file.data}` : file.url
      }))
    };
    
    res.json({
      success: true,
      message: messageWithUrl
    });
  } catch (error) {
    console.error('❌ Error fetching message:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch message',
      details: error.message 
    });
  }
});

// Socket.io for real-time communication with enhanced features
io.on('connection', (socket) => {
  console.log('👤 User connected:', socket.id);
  
  // Send connection confirmation
  socket.emit('connected', { 
    message: 'Connected to birthday app server',
    timestamp: new Date(),
    socketId: socket.id
  });
  
  // Handle room joining (for future features)
  socket.on('joinRoom', (room) => {
    socket.join(room);
    console.log(`User ${socket.id} joined room: ${room}`);
    socket.to(room).emit('userJoined', { socketId: socket.id, room });
  });
  
  // Handle message sending with validation
  socket.on('sendMessage', async (data) => {
    try {
      console.log('📩 Received message via socket:', {
        sender: data.sender,
        hasFiles: data.isFile,
        socketId: socket.id
      });
      
      // Validation
      if (!data.sender || !['Rafat Fatima', 'Adeeb'].includes(data.sender)) {
        socket.emit('error', { message: 'Invalid sender' });
        return;
      }
      
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
        text: data.text || (data.isFile ? `File: ${processedFiles[0]?.name}` : ''),
        sender: data.sender,
        timestamp: new Date(),
        isFile: !!data.isFile,
        files: processedFiles,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000)
      };
      
      const message = new Message(messageData);
      await message.save();
      
      // Prepare for broadcasting
      const broadcastMessage = {
        ...message.toObject(),
        files: message.files.map(file => ({
          ...file,
          url: file.data ? `data:${file.type};base64,${file.data}` : file.url
        }))
      };
      
      // Broadcast to all clients (including sender)
      io.emit('newMessage', broadcastMessage);
      
      console.log('✅ Message broadcasted:', {
        sender: data.sender,
        messageId: message._id,
        recipients: io.engine.clientsCount
      });
      
    } catch (error) {
      console.error('❌ Error saving message via socket:', error);
      socket.emit('error', { 
        message: 'Failed to send message',
        error: error.message 
      });
    }
  });
  
  // Handle typing indicators (future feature)
  socket.on('typingStart', (data) => {
    socket.broadcast.emit('userTyping', {
      sender: data.sender,
      isTyping: true
    });
  });
  
  socket.on('typingStop', (data) => {
    socket.broadcast.emit('userTyping', {
      sender: data.sender,
      isTyping: false
    });
  });
  
  // Handle disconnection
  socket.on('disconnect', (reason) => {
    console.log('👤 User disconnected:', socket.id, 'Reason:', reason);
  });
  
  // Handle errors
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('🚨 Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: error.message
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    availableEndpoints: {
      'GET /': 'API information',
      'GET /health': 'Health check',
      'GET /api/messages': 'Get messages',
      'POST /api/messages': 'Send message',
      'GET /api/messages/:id': 'Get specific message',
      'DELETE /api/messages/:id': 'Delete message'
    }
  });
});

// Graceful shutdown handling
process.on('SIGINT', async () => {
  console.log('🛑 Received SIGINT. Shutting down gracefully...');
  await mongoose.connection.close();
  server.close(() => {
    console.log('✅ Server shut down gracefully');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('🛑 Received SIGTERM. Shutting down gracefully...');
  await mongoose.connection.close();
  server.close(() => {
    console.log('✅ Server shut down gracefully');
    process.exit(0);
  });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`
🎉 Birthday App Server Started!
────────────────────────────────
📍 Port: ${PORT}
📡 Environment: ${process.env.NODE_ENV || 'development'}
🗄️ Database: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'}
⏰ Auto-delete: Enabled (2 hours)
📁 File upload: Enabled
🔗 WebSocket: Enabled

📋 Available endpoints:
   • http://localhost:${PORT} - API Info
   • http://localhost:${PORT}/health - Health Check
   • http://localhost:${PORT}/api/messages - Messages API

🚀 Server is ready to receive requests!
  `);
});

module.exports = app;
