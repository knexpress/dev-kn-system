const express = require('express');
const { CashTracker } = require('../models');
const { CashFlowTransaction } = require('../models/unified-schema');

const router = express.Router();

// Helper function to generate cash tracker ID
function generateCashTrackerId() {
  const year = new Date().getFullYear();
  const randomNum = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `CT-${year}-${randomNum}`;
}

// Memory management utilities
function getMemoryUsage() {
  const used = process.memoryUsage();
  return {
    heapUsed: Math.round(used.heapUsed / 1024 / 1024),
    heapTotal: Math.round(used.heapTotal / 1024 / 1024),
    rss: Math.round(used.rss / 1024 / 1024)
  };
}

function logMemoryUsage(label = '') {
  const mem = getMemoryUsage();
  console.log(`💾 Memory ${label}: Heap ${mem.heapUsed}MB/${mem.heapTotal}MB, RSS ${mem.rss}MB`);
  return mem;
}

function forceGarbageCollection() {
  if (global.gc) {
    global.gc();
    return true;
  }
  return false;
}

// Get all cash tracker transactions (from both CashTracker and CashFlowTransaction) with pagination
router.get('/', async (req, res) => {
  try {
    // Get pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200); // Max 200 per page
    const skip = (page - 1) * limit;
    
    logMemoryUsage('(before cash tracker query)');
    
    // Get total counts
    const oldTotal = await CashTracker.countDocuments();
    const newTotal = await CashFlowTransaction.countDocuments();
    const total = oldTotal + newTotal;
    
    // Fetch from both old CashTracker and new CashFlowTransaction with pagination
    // Use lean() to reduce memory usage
    const oldTransactions = await CashTracker.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
      
    const newTransactions = await CashFlowTransaction.find()
      .populate('created_by', 'full_name employee_id')
      .populate('entity_id')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
    
    logMemoryUsage('(after cash tracker query)');
    
    // Convert CashFlowTransaction to format expected by frontend
    const formattedNewTransactions = newTransactions.map(t => {
      const transactionData = t; // Already a plain object from lean()
      
      // Convert Decimal128 amount to number
      if (transactionData.amount) {
        transactionData.amount = typeof transactionData.amount === 'object'
          ? parseFloat(transactionData.amount.toString())
          : parseFloat(transactionData.amount);
      }
      
      return transactionData;
    });
    
    // Combine and sort by creation date
    const allTransactions = [...oldTransactions, ...formattedNewTransactions]
      .sort((a, b) => new Date(b.createdAt || b.transaction_date) - new Date(a.createdAt || a.transaction_date));
    
    // Final memory cleanup
    forceGarbageCollection();
    logMemoryUsage('(after processing)');
    
    console.log('📊 Cash flow transactions fetched:', {
      oldTransactions: oldTransactions.length,
      newTransactions: formattedNewTransactions.length,
      total: allTransactions.length,
      pagination: { page, limit, total }
    });
    
    res.json({
      success: true,
      data: allTransactions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching cash tracker transactions:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch transactions' 
    });
  }
});

// Create cash tracker transaction
router.post('/', async (req, res) => {
  try {
    const { category, amount, direction, payment_method, notes, entity_id, entity_type } = req.body;
    
    if (!category || !amount || !direction || !payment_method || !entity_type) {
      return res.status(400).json({ error: 'Category, amount, direction, payment method, and entity type are required' });
    }

    const transaction = new CashTracker({
      _id: generateCashTrackerId(),
      category,
      amount: parseFloat(amount),
      direction,
      payment_method,
      notes,
      entity_id: entity_id || undefined,
      entity_type
    });

    await transaction.save();

    res.status(201).json({
      success: true,
      transaction,
      message: 'Transaction created successfully'
    });
  } catch (error) {
    console.error('Error creating transaction:', error);
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

// Get cash flow summary (from both CashTracker and CashFlowTransaction)
// Uses aggregation for better performance and memory efficiency
router.get('/summary', async (req, res) => {
  try {
    logMemoryUsage('(before summary query)');
    
    // Use aggregation pipeline for better memory efficiency
    const oldSummary = await CashTracker.aggregate([
      {
        $group: {
          _id: '$direction',
          total: { $sum: { $toDouble: '$amount' } }
        }
      }
    ]);
    
    const newSummary = await CashFlowTransaction.aggregate([
      {
        $group: {
          _id: '$direction',
          total: { $sum: { $toDouble: '$amount' } }
        }
      }
    ]);
    
    logMemoryUsage('(after summary query)');
    
    // Combine results
    const summary = { totalIncome: 0, totalExpenses: 0 };
    
    [...oldSummary, ...newSummary].forEach(item => {
      if (item._id === 'IN') {
        summary.totalIncome += item.total || 0;
      } else {
        summary.totalExpenses += item.total || 0;
      }
    });

    summary.netCashFlow = summary.totalIncome - summary.totalExpenses;
    
    // Final memory cleanup
    forceGarbageCollection();
    logMemoryUsage('(after summary processing)');

    res.json(summary);
  } catch (error) {
    console.error('Error fetching cash flow summary:', error);
    res.status(500).json({ error: 'Failed to fetch cash flow summary' });
  }
});

module.exports = router;
