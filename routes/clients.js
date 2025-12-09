const express = require('express');
const { Client } = require('../models/unified-schema');

const router = express.Router();

// Get all clients
router.get('/', async (req, res) => {
  try {
    const clients = await Client.find().sort({ createdAt: -1 });
    res.json({
      success: true,
      data: clients
    });
  } catch (error) {
    console.error('Error fetching clients:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch clients' 
    });
  }
});

// Create client
router.post('/', async (req, res) => {
  try {
    console.log('Creating client with data:', req.body);
    
    const { 
      company_name, 
      contact_name, 
      email, 
      phone, 
      address, 
      city, 
      country 
    } = req.body;
    
    // Validate required fields
    if (!company_name) {
      return res.status(400).json({ 
        success: false,
        error: 'Company name is required' 
      });
    }
    
    if (!contact_name) {
      return res.status(400).json({ 
        success: false,
        error: 'Contact name is required' 
      });
    }
    
    if (!email) {
      return res.status(400).json({ 
        success: false,
        error: 'Email is required' 
      });
    }
    
    if (!phone) {
      return res.status(400).json({ 
        success: false,
        error: 'Phone is required' 
      });
    }
    
    if (!address) {
      return res.status(400).json({ 
        success: false,
        error: 'Address is required' 
      });
    }
    
    if (!city) {
      return res.status(400).json({ 
        success: false,
        error: 'City is required' 
      });
    }
    
    if (!country) {
      return res.status(400).json({ 
        success: false,
        error: 'Country is required' 
      });
    }

    const clientData = {
      company_name,
      contact_name,
      email,
      phone,
      address,
      city,
      country,
      isActive: true
    };
    
    console.log('Client data to save:', clientData);

    const client = new Client(clientData);
    await client.save();
    
    console.log('Client saved successfully:', client._id);

    res.status(201).json({
      success: true,
      data: client,
      message: 'Client created successfully'
    });
  } catch (error) {
    console.error('Error creating client:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create client',
      details: error.message
    });
  }
});

// Update client
router.put('/:id', async (req, res) => {
  try {
    const { company_name, contact_name, address } = req.body;
    const clientId = req.params.id;

    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    if (company_name) client.company_name = company_name;
    if (contact_name) client.contact_name = contact_name;
    if (address) client.address = address;

    await client.save();

    res.json({
      success: true,
      client,
      message: 'Client updated successfully'
    });
  } catch (error) {
    console.error('Error updating client:', error);
    res.status(500).json({ error: 'Failed to update client' });
  }
});

// Delete client
router.delete('/:id', async (req, res) => {
  try {
    const clientId = req.params.id;

    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    await Client.findByIdAndDelete(clientId);

    res.json({
      success: true,
      message: 'Client deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting client:', error);
    res.status(500).json({ error: 'Failed to delete client' });
  }
});

module.exports = router;
