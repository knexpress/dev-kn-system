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

// Get all cash tracker transactions (from both CashTracker and CashFlowTransaction)
router.get('/', async (req, res) => {
  try {
    // Fetch from both old CashTracker and new CashFlowTransaction
    const oldTransactions = await CashTracker.find().sort({ createdAt: -1 });
    const newTransactions = await CashFlowTransaction.find()
      .populate('created_by', 'full_name employee_id')
      .populate('entity_id')
      .sort({ createdAt: -1 });
    
    // Convert CashFlowTransaction to format expected by frontend
    const formattedNewTransactions = newTransactions.map(t => {
      const transactionData = t.toObject();
      
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
    
    console.log('📊 Cash flow transactions fetched:', {
      oldTransactions: oldTransactions.length,
      newTransactions: formattedNewTransactions.length,
      total: allTransactions.length,
      sample: allTransactions.slice(0, 2)
    });
    
    res.json({
      success: true,
      data: allTransactions
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
router.get('/summary', async (req, res) => {
  try {
    const oldTransactions = await CashTracker.find();
    const newTransactions = await CashFlowTransaction.find();
    
    const summary = [...oldTransactions, ...newTransactions].reduce((acc, transaction) => {
      const amount = parseFloat(transaction.amount.toString());
      
      if (transaction.direction === 'IN') {
        acc.totalIncome += amount;
      } else {
        acc.totalExpenses += amount;
      }
      
      return acc;
    }, { totalIncome: 0, totalExpenses: 0 });

    summary.netCashFlow = summary.totalIncome - summary.totalExpenses;

    res.json(summary);
  } catch (error) {
    console.error('Error fetching cash flow summary:', error);
    res.status(500).json({ error: 'Failed to fetch cash flow summary' });
  }
});

module.exports = router;
