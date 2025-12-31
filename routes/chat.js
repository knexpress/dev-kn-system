const express = require('express');
const mongoose = require('mongoose');
const { ChatRoom, ChatMessage, Department, Employee, User } = require('../models');

const router = express.Router();

// ========================================
// CHAT ROOMS
// ========================================

// Get all chat rooms for a user (both department and direct chats)
router.get('/rooms', async (req, res) => {
  try {
    const { user_id, department_id } = req.query;
    
    if (!user_id) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    
    let query = { is_active: true };
    
    // Get user's employee_id if available
    const user = await User.findById(user_id).populate('employee_id');
    const employeeId = user?.employee_id?._id || user?.employee_id;
    
    // Find rooms where user is a participant (direct chats) or department rooms
    const orConditions = [];
    
    // Direct chat rooms where user is a participant
    if (user_id) {
      // Use $in to find rooms where user_id is in the user_ids array
      orConditions.push({ room_type: 'direct', user_ids: { $in: [user_id] } });
    }
    if (employeeId) {
      orConditions.push({ room_type: 'direct', participants: { $in: [employeeId] } });
    }
    
    // Department rooms
    if (department_id) {
      orConditions.push({ room_type: 'department', department_ids: department_id });
    }
    
    if (orConditions.length > 0) {
      query.$or = orConditions;
    } else {
      query.is_active = false; // Return empty if no conditions
    }
    
    const rooms = await ChatRoom.find(query)
      .populate('department_ids', 'name description')
      .populate('participants', 'full_name email employee_id')
      .populate('user_ids', 'full_name email')
      .populate('created_by', 'full_name email')
      .sort({ updatedAt: -1 }); // Sort by last activity
    
    res.json({
      success: true,
      data: rooms
    });
  } catch (error) {
    console.error('Error fetching chat rooms:', error);
    res.status(500).json({ error: 'Failed to fetch chat rooms' });
  }
});

// Get or create a direct chat room between two users
router.post('/rooms/direct', async (req, res) => {
  try {
    const { user_id_1, user_id_2 } = req.body;
    
    if (!user_id_1 || !user_id_2) {
      return res.status(400).json({ error: 'Both user IDs are required' });
    }
    
    if (user_id_1 === user_id_2) {
      return res.status(400).json({ error: 'Cannot create chat with yourself' });
    }
    
    // Sort user IDs to ensure consistent room lookup
    const sortedUserIds = [user_id_1, user_id_2].sort();
    
    // Check if room already exists
    let room = await ChatRoom.findOne({
      room_type: 'direct',
      user_ids: { $all: sortedUserIds, $size: 2 }
    })
      .populate('department_ids', 'name description')
      .populate('participants', 'full_name email employee_id')
      .populate('user_ids', 'full_name email')
      .populate('created_by', 'full_name email');
    
    if (room) {
      return res.json({
        success: true,
        data: room,
        message: 'Chat room found'
      });
    }
    
    // Get user details for room name
    const user1 = await User.findById(sortedUserIds[0]);
    const user2 = await User.findById(sortedUserIds[1]);
    
    // Get employee IDs if available
    const employee1 = user1?.employee_id ? await Employee.findById(user1.employee_id) : null;
    const employee2 = user2?.employee_id ? await Employee.findById(user2.employee_id) : null;
    
    // Create new room
    room = new ChatRoom({
      name: `${user1?.full_name || 'User'} & ${user2?.full_name || 'User'}`,
      room_type: 'direct',
      user_ids: sortedUserIds,
      participants: [employee1?._id, employee2?._id].filter(Boolean),
      is_active: true,
      created_by: employee1?._id || user1?._id
    });
    
    await room.save();
    
    // Populate the room before sending
    const populatedRoom = await ChatRoom.findById(room._id)
      .populate('department_ids', 'name description')
      .populate('participants', 'full_name email employee_id')
      .populate('user_ids', 'full_name email')
      .populate('created_by', 'full_name email');
    
    res.status(201).json({
      success: true,
      data: populatedRoom,
      message: 'Chat room created successfully'
    });
  } catch (error) {
    console.error('Error creating direct chat room:', error);
    res.status(500).json({ error: 'Failed to create chat room' });
  }
});

// Get a specific chat room
router.get('/rooms/:id', async (req, res) => {
  try {
    const room = await ChatRoom.findById(req.params.id)
      .populate('department_ids', 'name description')
      .populate('participants', 'full_name email employee_id')
      .populate('user_ids', 'full_name email')
      .populate('created_by', 'full_name email');
    
    if (!room) {
      return res.status(404).json({ error: 'Chat room not found' });
    }
    
    res.json({
      success: true,
      data: room
    });
  } catch (error) {
    console.error('Error fetching chat room:', error);
    res.status(500).json({ error: 'Failed to fetch chat room' });
  }
});

// Create a new chat room
router.post('/rooms', async (req, res) => {
  try {
    const { name, description, department_ids, created_by } = req.body;
    
    if (!name || !department_ids || !Array.isArray(department_ids) || department_ids.length === 0) {
      return res.status(400).json({ error: 'Name and department_ids are required' });
    }
    
    // Check if room with same name already exists
    const existingRoom = await ChatRoom.findOne({ name });
    if (existingRoom) {
      return res.status(400).json({ error: 'Chat room with this name already exists' });
    }
    
    const room = new ChatRoom({
      name,
      description,
      department_ids,
      created_by,
      is_active: true
    });
    
    await room.save();
    
    const populatedRoom = await ChatRoom.findById(room._id)
      .populate('department_ids', 'name description')
      .populate('created_by', 'full_name email');
    
    res.status(201).json({
      success: true,
      data: populatedRoom,
      message: 'Chat room created successfully'
    });
  } catch (error) {
    console.error('Error creating chat room:', error);
    res.status(500).json({ error: 'Failed to create chat room' });
  }
});

// Update a chat room
router.put('/rooms/:id', async (req, res) => {
  try {
    const { name, description, department_ids, is_active } = req.body;
    
    const room = await ChatRoom.findById(req.params.id);
    if (!room) {
      return res.status(404).json({ error: 'Chat room not found' });
    }
    
    if (name) room.name = name;
    if (description !== undefined) room.description = description;
    if (department_ids) room.department_ids = department_ids;
    if (is_active !== undefined) room.is_active = is_active;
    
    await room.save();
    
    const populatedRoom = await ChatRoom.findById(room._id)
      .populate('department_ids', 'name description')
      .populate('created_by', 'full_name email');
    
    res.json({
      success: true,
      data: populatedRoom,
      message: 'Chat room updated successfully'
    });
  } catch (error) {
    console.error('Error updating chat room:', error);
    res.status(500).json({ error: 'Failed to update chat room' });
  }
});

// Delete a chat room
router.delete('/rooms/:id', async (req, res) => {
  try {
    const room = await ChatRoom.findById(req.params.id);
    if (!room) {
      return res.status(404).json({ error: 'Chat room not found' });
    }
    
    // Soft delete - set is_active to false
    room.is_active = false;
    await room.save();
    
    res.json({
      success: true,
      message: 'Chat room deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting chat room:', error);
    res.status(500).json({ error: 'Failed to delete chat room' });
  }
});

// ========================================
// CHAT MESSAGES
// ========================================

// Get messages for a specific chat room
router.get('/rooms/:roomId/messages', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { limit = 50, before } = req.query; // Pagination support
    
    // Check if room exists
    const room = await ChatRoom.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: 'Chat room not found' });
    }
    
    let query = { room_id: roomId };
    
    // Pagination: get messages before a specific date
    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }
    
    const messages = await ChatMessage.find(query)
      .populate('sender_id', 'full_name email employee_id')
      .populate('sender_department_id', 'name description')
      .populate('reply_to', 'message sender_id')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));
    
    // Reverse to show oldest first
    messages.reverse();
    
    res.json({
      success: true,
      data: messages,
      count: messages.length
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Send a message to a chat room
router.post('/rooms/:roomId/messages', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { sender_id, message, message_type = 'text', reply_to } = req.body;
    
    if (!sender_id || !message) {
      return res.status(400).json({ error: 'Sender ID and message are required' });
    }
    
    // Check if room exists
    const room = await ChatRoom.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: 'Chat room not found' });
    }
    
    // Get sender - try Employee first, then User (which has employee_id)
    let sender = await Employee.findById(sender_id).populate('department_id');
    let senderDepartmentId = null;
    
    if (!sender) {
      // Try to find user and get employee_id from it
      const { User } = require('../models');
      const user = await User.findById(sender_id).populate('department_id');
      if (user && user.employee_id) {
        sender = await Employee.findById(user.employee_id).populate('department_id');
        if (sender) {
          senderDepartmentId = sender.department_id._id;
        } else {
          // If no employee found, use user's department
          senderDepartmentId = user.department_id._id;
          // Create a temporary sender object for the response
          sender = {
            _id: user._id,
            full_name: user.full_name,
            email: user.email,
            department_id: user.department_id
          };
        }
      } else if (user) {
        // User exists but no employee_id - use user's department
        senderDepartmentId = user.department_id._id;
        sender = {
          _id: user._id,
          full_name: user.full_name,
          email: user.email,
          department_id: user.department_id
        };
      }
    } else {
      senderDepartmentId = sender.department_id._id;
    }
    
    if (!sender || !senderDepartmentId) {
      return res.status(404).json({ error: 'Sender not found or has no department' });
    }
    
    // Use employee_id if available, otherwise use sender_id (which might be user_id)
    const actualSenderId = sender._id;
    
    const chatMessage = new ChatMessage({
      room_id: roomId,
      sender_id: actualSenderId,
      sender_department_id: senderDepartmentId,
      message,
      message_type,
      reply_to,
      is_read: false
    });
    
    await chatMessage.save();
    
    // Populate the message before sending
    const populatedMessage = await ChatMessage.findById(chatMessage._id)
      .populate('sender_id', 'full_name email employee_id')
      .populate('sender_department_id', 'name description')
      .populate('reply_to', 'message sender_id');
    
    res.status(201).json({
      success: true,
      data: populatedMessage,
      message: 'Message sent successfully'
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Mark message as read
router.put('/messages/:messageId/read', async (req, res) => {
  try {
    const { messageId } = req.params;
    const { employee_id } = req.body;
    
    if (!employee_id) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }
    
    const message = await ChatMessage.findById(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    // Check if already read by this employee
    const alreadyRead = message.read_by.some(
      read => read.employee_id.toString() === employee_id
    );
    
    if (!alreadyRead) {
      message.read_by.push({
        employee_id,
        read_at: new Date()
      });
      message.is_read = true;
      await message.save();
    }
    
    res.json({
      success: true,
      message: 'Message marked as read'
    });
  } catch (error) {
    console.error('Error marking message as read:', error);
    res.status(500).json({ error: 'Failed to mark message as read' });
  }
});

// Mark all messages in a room as read
router.put('/rooms/:roomId/read', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { employee_id } = req.body;
    
    if (!employee_id) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }
    
    const messages = await ChatMessage.find({
      room_id: roomId,
      'read_by.employee_id': { $ne: employee_id }
    });
    
    for (const message of messages) {
      message.read_by.push({
        employee_id,
        read_at: new Date()
      });
      message.is_read = true;
      await message.save();
    }
    
    res.json({
      success: true,
      message: 'All messages marked as read',
      count: messages.length
    });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

// Get unread message count for a user
router.get('/unread-count', async (req, res) => {
  try {
    const { employee_id, room_id } = req.query;
    
    if (!employee_id) {
      return res.status(400).json({ error: 'Employee ID is required' });
    }
    
    let query = {
      'read_by.employee_id': { $ne: employee_id }
    };
    
    if (room_id) {
      query.room_id = room_id;
    }
    
    const count = await ChatMessage.countDocuments(query);
    
    res.json({
      success: true,
      count
    });
  } catch (error) {
    console.error('Error getting unread count:', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// Get chat history for a room (with pagination)
router.get('/rooms/:roomId/history', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    
    const room = await ChatRoom.findById(roomId);
    if (!room) {
      return res.status(404).json({ error: 'Chat room not found' });
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const messages = await ChatMessage.find({ room_id: roomId })
      .populate('sender_id', 'full_name email employee_id')
      .populate('sender_department_id', 'name description')
      .populate('reply_to', 'message sender_id')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await ChatMessage.countDocuments({ room_id: roomId });
    
    res.json({
      success: true,
      data: messages.reverse(), // Reverse to show oldest first
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching chat history:', error);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

// Delete a message (soft delete - mark as deleted)
router.delete('/messages/:messageId', async (req, res) => {
  try {
    const message = await ChatMessage.findById(req.params.messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    
    // For now, we'll actually delete it. In production, you might want to soft delete
    await ChatMessage.findByIdAndDelete(req.params.messageId);
    
    res.json({
      success: true,
      message: 'Message deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// ========================================
// AVAILABLE USERS FOR CHAT
// ========================================

// Get all available users for chat (excluding current user)
router.get('/users', async (req, res) => {
  try {
    const { current_user_id } = req.query;
    
    if (!current_user_id) {
      return res.status(400).json({ error: 'Current user ID is required' });
    }
    
    // Get all active users except current user
    const users = await User.find({
      _id: { $ne: current_user_id },
      isActive: true
    })
      .populate('department_id', 'name description')
      .populate('employee_id', 'full_name email')
      .select('-password')
      .sort({ full_name: 1 });
    
    res.json({
      success: true,
      data: users
    });
  } catch (error) {
    console.error('Error fetching available users:', error);
    res.status(500).json({ error: 'Failed to fetch available users' });
  }
});

module.exports = router;

