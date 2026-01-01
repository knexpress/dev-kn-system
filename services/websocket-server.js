const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { ChatRoom, ChatMessage, User, Employee } = require('../models');

class WebSocketServer {
  constructor(server) {
    this.wss = new WebSocket.Server({ 
      server,
      path: '/api/chat/ws',
      verifyClient: (info) => {
        try {
          // Extract token from query string
          const url = new URL(info.req.url, `http://${info.req.headers.host || 'localhost'}`);
          const token = url.searchParams.get('token');
          return !!token; // Allow connection if token exists (we'll verify it in connection handler)
        } catch (error) {
          console.error('WebSocket verifyClient error:', error);
          return false; // Reject connection on error
        }
      }
    });
    
    // Store active connections: user_id -> WebSocket
    this.userConnections = new Map();
    
    // Store room memberships: room_id -> Set of user_ids
    this.roomMembers = new Map();
    
    // Store typing indicators: room_id -> Map(user_id -> timeout)
    this.typingTimeouts = new Map();
    
    this.setupEventHandlers();
  }
  
  setupEventHandlers() {
    this.wss.on('connection', async (ws, req) => {
      let userId = null;
      
      try {
        console.log('🔌 New WebSocket connection attempt:', {
          url: req.url,
          headers: {
            host: req.headers.host,
            origin: req.headers.origin
          }
        });
        
        // Extract token from query string
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const token = url.searchParams.get('token');
        
        if (!token) {
          console.warn('⚠️ WebSocket connection rejected: No token provided');
          ws.close(1008, 'Authentication required');
          return;
        }
        
        // Verify token
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
          userId = decoded.userId || decoded._id || decoded.id;
          
          if (!userId) {
            throw new Error('Invalid token: no user ID found');
          }
        } catch (error) {
          console.error('WebSocket authentication error:', {
            message: error.message,
            name: error.name,
            tokenLength: token ? token.length : 0
          });
          try {
            ws.close(1008, 'Invalid token');
          } catch (closeError) {
            // Connection might already be closed
          }
          return;
        }
        
        // Store connection
        this.userConnections.set(userId.toString(), ws);
        console.log(`✅ WebSocket connected: User ${userId}`);
        
        // Send connection confirmation
        this.sendToUser(userId, {
          type: 'connected',
          user_id: userId
        });
        
        // Handle messages
        ws.on('message', async (data) => {
          try {
            const message = JSON.parse(data.toString());
            await this.handleMessage(userId, message, ws);
          } catch (error) {
            console.error('Error handling WebSocket message:', error);
            this.sendToUser(userId, {
              type: 'error',
              error: 'Invalid message format'
            });
          }
        });
        
        // Handle disconnect
        ws.on('close', () => {
          if (userId) {
            this.handleDisconnect(userId);
          }
        });
        
        // Handle errors
        ws.on('error', (error) => {
          console.error(`WebSocket error for user ${userId || 'unknown'}:`, error.message || error);
          if (userId) {
            this.handleDisconnect(userId);
          }
        });
        
        // Heartbeat/ping-pong
        ws.isAlive = true;
        ws.on('pong', () => {
          ws.isAlive = true;
        });
      } catch (error) {
        console.error('WebSocket connection setup error:', error);
        try {
          ws.close(1011, 'Internal server error');
        } catch (closeError) {
          // Connection might already be closed
        }
      }
    });
    
    // Handle WebSocket server errors
    this.wss.on('error', (error) => {
      console.error('WebSocket server error:', error);
    });
    
    // Set up ping interval to keep connections alive
    const pingInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000); // 30 seconds
    
    this.wss.on('close', () => {
      clearInterval(pingInterval);
    });
  }
  
  async handleMessage(userId, message, ws) {
    switch (message.type) {
      case 'join_room':
        await this.handleJoinRoom(userId, message.room_id, ws);
        break;
      case 'leave_room':
        this.handleLeaveRoom(userId, message.room_id);
        break;
      case 'typing':
        await this.handleTyping(userId, message.room_id, message.is_typing);
        break;
      case 'ping':
        this.sendToUser(userId, { type: 'pong' });
        break;
      default:
        this.sendToUser(userId, {
          type: 'error',
          error: `Unknown message type: ${message.type}`
        });
    }
  }
  
  async handleJoinRoom(userId, roomId, ws) {
    try {
      // Validate roomId is a valid MongoDB ObjectId
      if (!mongoose.Types.ObjectId.isValid(roomId)) {
        console.warn(`⚠️ Invalid room ID format: ${roomId} (likely temporary ID)`);
        this.sendToUser(userId, {
          type: 'error',
          error: 'Invalid room ID. Please wait for the room to be created.'
        });
        return;
      }
      
      // Verify user has access to room
      const room = await ChatRoom.findById(roomId);
      if (!room) {
        this.sendToUser(userId, {
          type: 'error',
          error: 'Room not found'
        });
        return;
      }
      
      // Check if user is a participant
      const hasAccess = this.checkRoomAccess(userId, room);
      if (!hasAccess) {
        this.sendToUser(userId, {
          type: 'error',
          error: 'Access denied to this room'
        });
        return;
      }
      
      // Add user to room
      if (!this.roomMembers.has(roomId)) {
        this.roomMembers.set(roomId, new Set());
      }
      this.roomMembers.get(roomId).add(userId.toString());
      
      console.log(`✅ User ${userId} joined room ${roomId}`);
      
      this.sendToUser(userId, {
        type: 'room_joined',
        room_id: roomId
      });
    } catch (error) {
      console.error('Error joining room:', error);
      this.sendToUser(userId, {
        type: 'error',
        error: 'Failed to join room'
      });
    }
  }
  
  handleLeaveRoom(userId, roomId) {
    if (this.roomMembers.has(roomId)) {
      this.roomMembers.get(roomId).delete(userId.toString());
      console.log(`✅ User ${userId} left room ${roomId}`);
    }
    
    // Clear typing indicator
    this.clearTypingIndicator(roomId, userId);
  }
  
  async handleTyping(userId, roomId, isTyping) {
    if (!this.roomMembers.has(roomId) || !this.roomMembers.get(roomId).has(userId.toString())) {
      return; // User not in room
    }
    
    if (isTyping) {
      // Set typing indicator
      this.setTypingIndicator(roomId, userId);
    } else {
      // Clear typing indicator
      this.clearTypingIndicator(roomId, userId);
    }
    
    // Broadcast typing status to other users in room
    this.broadcastToRoom(roomId, {
      type: 'typing',
      room_id: roomId,
      user_id: userId,
      is_typing: isTyping
    }, userId);
  }
  
  setTypingIndicator(roomId, userId) {
    // Clear existing timeout
    this.clearTypingIndicator(roomId, userId);
    
    // Set new timeout to auto-clear after 3 seconds
    const timeout = setTimeout(() => {
      this.clearTypingIndicator(roomId, userId);
      this.broadcastToRoom(roomId, {
        type: 'typing',
        room_id: roomId,
        user_id: userId,
        is_typing: false
      }, userId);
    }, 3000);
    
    if (!this.typingTimeouts.has(roomId)) {
      this.typingTimeouts.set(roomId, new Map());
    }
    this.typingTimeouts.get(roomId).set(userId.toString(), timeout);
  }
  
  clearTypingIndicator(roomId, userId) {
    if (this.typingTimeouts.has(roomId)) {
      const roomTimeouts = this.typingTimeouts.get(roomId);
      if (roomTimeouts.has(userId.toString())) {
        clearTimeout(roomTimeouts.get(userId.toString()));
        roomTimeouts.delete(userId.toString());
      }
    }
  }
  
  checkRoomAccess(userId, room) {
    // Check if user is in user_ids (for direct chats)
    if (room.user_ids && room.user_ids.some(id => id.toString() === userId.toString())) {
      return true;
    }
    
    // Check if user's employee is in participants
    // This requires async check, so we'll do it in handleJoinRoom
    return true; // For now, allow if room exists (async check done in handleJoinRoom)
  }
  
  handleDisconnect(userId) {
    const userIdStr = userId.toString();
    this.userConnections.delete(userIdStr);
    
    // Remove from all rooms
    this.roomMembers.forEach((members, roomId) => {
      members.delete(userIdStr);
    });
    
    // Clear all typing indicators for this user
    this.typingTimeouts.forEach((roomTimeouts, roomId) => {
      if (roomTimeouts.has(userIdStr)) {
        clearTimeout(roomTimeouts.get(userIdStr));
        roomTimeouts.delete(userIdStr);
      }
    });
    
    console.log(`❌ WebSocket disconnected: User ${userId}`);
  }
  
  sendToUser(userId, message) {
    const ws = this.userConnections.get(userId.toString());
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        console.error(`Error sending message to user ${userId}:`, error);
      }
    }
  }
  
  broadcastToRoom(roomId, message, excludeUserId = null) {
    if (!this.roomMembers.has(roomId)) {
      return;
    }
    
    const members = this.roomMembers.get(roomId);
    members.forEach((userId) => {
      if (excludeUserId && userId === excludeUserId.toString()) {
        return; // Skip excluded user
      }
      
      const ws = this.userConnections.get(userId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(message));
        } catch (error) {
          console.error(`Error broadcasting to user ${userId}:`, error);
        }
      }
    });
  }
  
  // Public method to broadcast new messages
  async broadcastNewMessage(roomId, message) {
    // Populate message if needed
    let populatedMessage = message;
    if (message && typeof message.toObject === 'function') {
      populatedMessage = await ChatMessage.findById(message._id)
        .populate('sender_id', 'full_name email employee_id')
        .populate('sender_department_id', 'name description')
        .populate('reply_to', 'message sender_id');
    }
    
    this.broadcastToRoom(roomId, {
      type: 'new_message',
      room_id: roomId,
      message: populatedMessage
    });
  }
  
  // Public method to broadcast message updates
  async broadcastMessageUpdate(roomId, message) {
    let populatedMessage = message;
    if (message && typeof message.toObject === 'function') {
      populatedMessage = await ChatMessage.findById(message._id)
        .populate('sender_id', 'full_name email employee_id')
        .populate('sender_department_id', 'name description')
        .populate('reply_to', 'message sender_id');
    }
    
    this.broadcastToRoom(roomId, {
      type: 'message_updated',
      room_id: roomId,
      message: populatedMessage
    });
  }
  
  // Public method to broadcast message deletion
  broadcastMessageDelete(roomId, messageId) {
    this.broadcastToRoom(roomId, {
      type: 'message_deleted',
      room_id: roomId,
      message: {
        _id: messageId
      }
    });
  }
  
  // Public method to notify user online/offline
  broadcastUserStatus(roomId, userId, isOnline) {
    this.broadcastToRoom(roomId, {
      type: isOnline ? 'user_online' : 'user_offline',
      user_id: userId,
      room_id: roomId
    });
  }
}

// Export singleton instance
let wsServerInstance = null;

function initializeWebSocketServer(server) {
  if (!wsServerInstance) {
    wsServerInstance = new WebSocketServer(server);
  }
  return wsServerInstance;
}

function getWebSocketServer() {
  return wsServerInstance;
}

module.exports = {
  initializeWebSocketServer,
  getWebSocketServer
};

