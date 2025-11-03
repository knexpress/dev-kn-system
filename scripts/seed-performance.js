require('dotenv').config();
const mongoose = require('mongoose');
const { PerformanceMetrics, Department } = require('../models');

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://aliabdullah:knex22939@finance.gk7t9we.mongodb.net/finance?retryWrites=true&w=majority&appName=Finance';

async function seedPerformanceData() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Get all departments
    const departments = await Department.find();
    
    const currentDate = new Date();
    const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
    const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);

    // Create performance metrics for each department
    for (const dept of departments) {
      // Check if metrics already exist for this month
      const existingMetrics = await PerformanceMetrics.findOne({
        department_id: dept._id,
        period: 'monthly',
        period_start: startOfMonth,
        period_end: endOfMonth
      });

      if (!existingMetrics) {
        const metrics = generateMockMetricsForDepartment(dept.name);
        
        const performanceMetric = new PerformanceMetrics({
          department_id: dept._id,
          period: 'monthly',
          period_start: startOfMonth,
          period_end: endOfMonth,
          metrics: metrics
        });

        await performanceMetric.save();
        console.log(`✅ Created performance metrics for ${dept.name}`);
      } else {
        console.log(`⏭️  Performance metrics already exist for ${dept.name}`);
      }
    }

    console.log('✅ Performance data seeding completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding performance data:', error);
    process.exit(1);
  }
}

function generateMockMetricsForDepartment(departmentName) {
  const baseMetrics = {
    // Sales Metrics
    total_revenue: Math.floor(Math.random() * 50000) + 10000,
    new_clients: Math.floor(Math.random() * 20) + 5,
    conversion_rate: Math.round((Math.random() * 30 + 60) * 100) / 100, // 60-90%
    client_satisfaction: Math.floor(Math.random() * 20) + 80, // 80-100
    
    // Operations Metrics
    total_shipments: Math.floor(Math.random() * 100) + 50,
    on_time_delivery_rate: Math.round((Math.random() * 20 + 80) * 100) / 100, // 80-100%
    error_rate: Math.round((Math.random() * 5) * 100) / 100, // 0-5%
    average_processing_time: Math.round((Math.random() * 24 + 2) * 100) / 100, // 2-26 hours
    
    // Finance Metrics
    total_collections: Math.floor(Math.random() * 30000) + 10000,
    collections_rate: Math.round((Math.random() * 20 + 75) * 100) / 100, // 75-95%
    outstanding_invoices: Math.floor(Math.random() * 10) + 2,
    average_payment_time: Math.round((Math.random() * 10 + 5) * 100) / 100, // 5-15 days
    
    // HR Metrics
    employee_count: Math.floor(Math.random() * 20) + 10,
    attendance_rate: Math.round((Math.random() * 10 + 90) * 100) / 100, // 90-100%
    employee_satisfaction: Math.floor(Math.random() * 15) + 80, // 80-95
    training_completion_rate: Math.round((Math.random() * 15 + 80) * 100) / 100, // 80-95%
    
    // IT Metrics
    system_uptime: Math.round((Math.random() * 4 + 96) * 100) / 100, // 96-100%
    tickets_resolved: Math.floor(Math.random() * 50) + 20,
    average_resolution_time: Math.round((Math.random() * 8 + 2) * 100) / 100, // 2-10 hours
    system_performance: Math.floor(Math.random() * 15) + 85, // 85-100
    
    // Auditor Metrics
    audits_completed: Math.floor(Math.random() * 5) + 3, // 3-7
    compliance_rate: Math.round((Math.random() * 15 + 85) * 100) / 100, // 85-100%
    risk_score: Math.floor(Math.random() * 30) + 10, // 10-40 (lower is better)
    findings_count: Math.floor(Math.random() * 8) + 2, // 2-9
    
    // Management Metrics (Company-wide)
    total_company_revenue: Math.floor(Math.random() * 100000) + 50000,
    total_company_shipments: Math.floor(Math.random() * 200) + 100,
    customer_satisfaction: Math.floor(Math.random() * 15) + 85, // 85-100
    operational_efficiency: Math.floor(Math.random() * 10) + 85, // 85-95
    employee_productivity: Math.floor(Math.random() * 10) + 80, // 80-90
    profit_margin: Math.floor(Math.random() * 10) + 15, // 15-25%
    market_share: Math.round((Math.random() * 5 + 15) * 100) / 100, // 15-20%
    risk_assessment: Math.floor(Math.random() * 15) + 80, // 80-95
  };

  // Return only relevant metrics for the department
  switch (departmentName) {
    case 'Sales':
      return {
        total_revenue: baseMetrics.total_revenue,
        new_clients: baseMetrics.new_clients,
        conversion_rate: baseMetrics.conversion_rate,
        client_satisfaction: baseMetrics.client_satisfaction,
      };
    case 'Operations':
      return {
        total_shipments: baseMetrics.total_shipments,
        on_time_delivery_rate: baseMetrics.on_time_delivery_rate,
        error_rate: baseMetrics.error_rate,
        average_processing_time: baseMetrics.average_processing_time,
      };
    case 'Finance':
      return {
        total_collections: baseMetrics.total_collections,
        collections_rate: baseMetrics.collections_rate,
        outstanding_invoices: baseMetrics.outstanding_invoices,
        average_payment_time: baseMetrics.average_payment_time,
      };
    case 'HR':
      return {
        employee_count: baseMetrics.employee_count,
        attendance_rate: baseMetrics.attendance_rate,
        employee_satisfaction: baseMetrics.employee_satisfaction,
        training_completion_rate: baseMetrics.training_completion_rate,
      };
    case 'IT':
      return {
        system_uptime: baseMetrics.system_uptime,
        tickets_resolved: baseMetrics.tickets_resolved,
        average_resolution_time: baseMetrics.average_resolution_time,
        system_performance: baseMetrics.system_performance,
      };
    case 'Auditor':
      return {
        audits_completed: baseMetrics.audits_completed,
        compliance_rate: baseMetrics.compliance_rate,
        risk_score: baseMetrics.risk_score,
        findings_count: baseMetrics.findings_count,
      };
    case 'Management':
      return {
        total_company_revenue: baseMetrics.total_company_revenue,
        total_company_shipments: baseMetrics.total_company_shipments,
        customer_satisfaction: baseMetrics.customer_satisfaction,
        operational_efficiency: baseMetrics.operational_efficiency,
        employee_productivity: baseMetrics.employee_productivity,
        profit_margin: baseMetrics.profit_margin,
        market_share: baseMetrics.market_share,
        risk_assessment: baseMetrics.risk_assessment,
      };
    default:
      return {};
  }
}

seedPerformanceData();
