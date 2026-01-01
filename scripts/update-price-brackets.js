const mongoose = require('mongoose');
require('dotenv').config();
const { PriceBracket } = require('../models/unified-schema');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/finance-system');

async function updatePriceBrackets() {
  try {
    console.log('🔄 Updating price brackets...\n');

    // PHILIPPINES TO UAE RATES
    const phToUaeBrackets = [
      { min: 1, max: 15, rate: 39, label: '1-15 KG' },
      { min: 16, max: 29, rate: 38, label: '16-29 KG' },
      { min: 30, max: 69, rate: 36, label: '30-69 KG' },
      { min: 70, max: 199, rate: 34, label: '70-199 KG' },
      { min: 200, max: 299, rate: 31, label: '200-299 KG' },
      { min: 300, max: null, rate: 30, label: '300 ABOVE KG' },
      { min: 0, max: null, rate: 29, label: 'SPECIAL RATE' } // Special rate (can override others)
    ];

    // UAE TO PHILIPPINES RATES
    const uaeToPhBrackets = [
      { min: 1, max: 15, rate: 39, label: '1-15 KG' },
      { min: 16, max: 29, rate: 38, label: '16-29 KG' },
      { min: 30, max: 69, rate: 36, label: '30-69 KG' },
      { min: 70, max: 99, rate: 34, label: '70-99 KG' },
      { min: 100, max: 199, rate: 31, label: '100-199 KG' },
      { min: 200, max: null, rate: 30, label: '200 ABOVE KG' },
      { min: 0, max: null, rate: 29, label: 'SPECIAL RATE' }, // Special rate (can override others)
      { min: 1000, max: null, rate: 28, label: '1 TON UP' } // 1 ton = 1000 kg
    ];

    // Update or create PH_TO_UAE price bracket
    const phToUae = await PriceBracket.findOneAndUpdate(
      { route: 'PH_TO_UAE' },
      {
        route: 'PH_TO_UAE',
        brackets: phToUaeBrackets,
        updated_at: new Date()
      },
      { upsert: true, new: true }
    );

    console.log('✅ PH_TO_UAE price brackets updated:');
    phToUaeBrackets.forEach(bracket => {
      const maxLabel = bracket.max === null ? '∞' : bracket.max;
      console.log(`   ${bracket.label}: ${bracket.rate} (${bracket.min}-${maxLabel} KG)`);
    });

    // Update or create UAE_TO_PH price bracket
    const uaeToPh = await PriceBracket.findOneAndUpdate(
      { route: 'UAE_TO_PH' },
      {
        route: 'UAE_TO_PH',
        brackets: uaeToPhBrackets,
        updated_at: new Date()
      },
      { upsert: true, new: true }
    );

    console.log('\n✅ UAE_TO_PH price brackets updated:');
    uaeToPhBrackets.forEach(bracket => {
      const maxLabel = bracket.max === null ? '∞' : bracket.max;
      console.log(`   ${bracket.label}: ${bracket.rate} (${bracket.min}-${maxLabel} KG)`);
    });

    console.log('\n✅ Price brackets updated successfully!');
    console.log(`   PH_TO_UAE ID: ${phToUae._id}`);
    console.log(`   UAE_TO_PH ID: ${uaeToPh._id}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error updating price brackets:', error);
    process.exit(1);
  }
}

// Run the update
updatePriceBrackets();

