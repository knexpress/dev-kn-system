const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { 
  Request, 
  Ticket, 
  InvoiceRequest, 
  Collections, 
  User, 
  Employee,
  CashTracker,
  PerformanceMetrics,
  Department
} = require('../models');
const auth = require('../middleware/auth');

// Get performance metrics for a specific department
router.get('/department/:department', auth, async (req, res) => {
  try {
    const { department } = req.params;
    const currentDate = new Date();
    const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
    const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
    
    // Get department ID
    const dept = await Department.findOne({ name: department });
    if (!dept) {
      return res.status(400).json({ error: 'Invalid department' });
    }

    // Check if we have cached metrics for this month
    let cachedMetrics = await PerformanceMetrics.findOne({
      department_id: dept._id,
      period: 'monthly',
      period_start: startOfMonth,
      period_end: endOfMonth
    });

    // If no cached metrics or they're older than 1 hour, recalculate
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if (!cachedMetrics || cachedMetrics.calculated_at < oneHourAgo) {
      const metrics = await calculateDepartmentMetrics(department, startOfMonth, endOfMonth);
      
      // Save or update cached metrics
      if (cachedMetrics) {
        cachedMetrics.metrics = metrics;
        cachedMetrics.calculated_at = new Date();
        await cachedMetrics.save();
      } else {
        cachedMetrics = new PerformanceMetrics({
          department_id: dept._id,
          period: 'monthly',
          period_start: startOfMonth,
          period_end: endOfMonth,
          metrics: metrics
        });
        await cachedMetrics.save();
      }
    }

    res.json({
      success: true,
      data: cachedMetrics.metrics
    });

  } catch (error) {
    console.error('Error fetching performance metrics:', error);
    res.status(500).json({ error: 'Failed to fetch performance metrics' });
  }
});

// Calculate performance metrics based on actual database data
async function calculateDepartmentMetrics(department, startDate, endDate) {
  let metrics = {};

  switch (department) {
    case 'Sales':
      metrics = await calculateSalesMetrics(startDate, endDate);
      break;
    case 'Operations':
      metrics = await calculateOperationsMetrics(startDate, endDate);
      break;
    case 'Finance':
      metrics = await calculateFinanceMetrics(startDate, endDate);
      break;
    case 'HR':
      metrics = await calculateHRMetrics(startDate, endDate);
      break;
    case 'Management':
      metrics = await calculateManagementMetrics(startDate, endDate);
      break;
    case 'IT':
      metrics = await calculateITMetrics(startDate, endDate);
      break;
    case 'Auditor':
      metrics = await calculateAuditorMetrics(startDate, endDate);
      break;
    default:
      metrics = {};
  }

  return metrics;
}

// Sales Department Metrics
async function calculateSalesMetrics(startDate, endDate) {
  try {
    // Get invoice requests created by sales team in the period
    const salesDept = await Department.findOne({ name: 'Sales' });
    const salesRequests = await InvoiceRequest.find({
      created_at: { $gte: startDate, $lte: endDate },
      status: { $in: ['COMPLETED', 'VERIFIED'] }
    });

    // Calculate revenue from completed requests
    const totalRevenue = salesRequests.reduce((sum, req) => {
      return sum + (req.invoice_amount || 0);
    }, 0);

    // Calculate conversion rate (completed vs total requests)
    const totalRequests = await InvoiceRequest.countDocuments({
      created_at: { $gte: startDate, $lte: endDate }
    });
    const conversionRate = totalRequests > 0 ? (salesRequests.length / totalRequests) * 100 : 0;

    // Get new clients (unique customers in the period)
    const newClients = await InvoiceRequest.distinct('customer_name', {
      created_at: { $gte: startDate, $lte: endDate }
    });

    // Mock client satisfaction (in real system, this would come from surveys)
    const clientSatisfaction = Math.min(95, 70 + (conversionRate * 0.2) + Math.random() * 10);

    return {
      total_revenue: Math.round(totalRevenue),
      new_clients: newClients.length,
      conversion_rate: Math.round(conversionRate * 100) / 100,
      client_satisfaction: Math.round(clientSatisfaction),
    };
  } catch (error) {
    console.error('Error calculating sales metrics:', error);
    return { total_revenue: 0, new_clients: 0, conversion_rate: 0, client_satisfaction: 0 };
  }
}

// Operations Department Metrics
async function calculateOperationsMetrics(startDate, endDate) {
  try {
    // Get all invoice requests processed in the period
    const processedRequests = await InvoiceRequest.find({
      created_at: { $gte: startDate, $lte: endDate },
      status: { $in: ['VERIFIED', 'COMPLETED'] }
    });

    const totalShipments = processedRequests.length;

    // Calculate on-time delivery rate (based on delivery status)
    const onTimeDeliveries = processedRequests.filter(req => 
      req.delivery_status === 'DELIVERED'
    ).length;
    const onTimeDeliveryRate = totalShipments > 0 ? (onTimeDeliveries / totalShipments) * 100 : 0;

    // Calculate error rate (based on failed deliveries)
    const failedDeliveries = processedRequests.filter(req => 
      req.delivery_status === 'FAILED'
    ).length;
    const errorRate = totalShipments > 0 ? (failedDeliveries / totalShipments) * 100 : 0;

    // Calculate average processing time (time from SUBMITTED to VERIFIED)
    let totalProcessingTime = 0;
    let validProcessingTimes = 0;

    for (const request of processedRequests) {
      if (request.verified_at && request.created_at) {
        const processingTime = (request.verified_at - request.created_at) / (1000 * 60 * 60); // hours
        totalProcessingTime += processingTime;
        validProcessingTimes++;
      }
    }

    const averageProcessingTime = validProcessingTimes > 0 ? totalProcessingTime / validProcessingTimes : 0;

    return {
      total_shipments: totalShipments,
      on_time_delivery_rate: Math.round(onTimeDeliveryRate * 100) / 100,
      error_rate: Math.round(errorRate * 100) / 100,
      average_processing_time: Math.round(averageProcessingTime * 100) / 100,
    };
  } catch (error) {
    console.error('Error calculating operations metrics:', error);
    return { total_shipments: 0, on_time_delivery_rate: 0, error_rate: 0, average_processing_time: 0 };
  }
}

// Finance Department Metrics
async function calculateFinanceMetrics(startDate, endDate) {
  try {
    const { Invoice, CashFlowTransaction } = require('../models/unified-schema');
    
    // Get invoices from database
    const invoices = await Invoice.find({
      createdAt: { $gte: startDate, $lte: endDate }
    });

    // Calculate total revenue (from all invoices)
    const totalRevenue = invoices.reduce((sum, inv) => {
      const amount = parseFloat(inv.total_amount?.toString() || '0');
      return sum + amount;
    }, 0);

    // Calculate collections rate (collected/remitted vs total invoices)
    const collectedInvoices = invoices.filter(inv => 
      inv.status === 'COLLECTED_BY_DRIVER' || inv.status === 'REMITTED'
    ).length;
    const collectionsRate = invoices.length > 0 ? (collectedInvoices / invoices.length) * 100 : 0;

    // Calculate outstanding invoices
    const outstandingInvoices = invoices.filter(inv => 
      inv.status === 'UNPAID'
    ).length;

    // Get cash flow transactions for this month
    const cashFlowTransactions = await CashFlowTransaction.find({
      transaction_date: { $gte: startDate, $lte: endDate },
      direction: 'IN'
    });

    // Calculate net cash flow (income - expenses)
    let totalIncome = 0;
    let totalExpenses = 0;
    
    for (const transaction of cashFlowTransactions) {
      const amount = parseFloat(transaction.amount?.toString() || '0');
      if (transaction.direction === 'IN') {
        totalIncome += amount;
      } else {
        totalExpenses += amount;
      }
    }
    
    const netCashFlow = totalIncome - totalExpenses;

    // Calculate invoice processing time (average time from creation to collection)
    let totalProcessingTime = 0;
    let validProcessingTimes = 0;

    for (const invoice of invoices) {
      if (invoice.updatedAt && invoice.createdAt && (invoice.status === 'COLLECTED_BY_DRIVER' || invoice.status === 'REMITTED')) {
        const processingTime = (invoice.updatedAt - invoice.createdAt) / (1000 * 60 * 60 * 24); // days
        totalProcessingTime += processingTime;
        validProcessingTimes++;
      }
    }

    const invoiceProcessingTime = validProcessingTimes > 0 ? totalProcessingTime / validProcessingTimes : 0;

    // Calculate budget utilization (mock - would come from budget data)
    const budgetUtilization = Math.round((netCashFlow / 100000) * 100); // Assuming 100k monthly budget

    console.log('💰 Finance metrics calculated:', {
      totalRevenue,
      collectionsRate,
      outstandingInvoices,
      netCashFlow,
      invoiceProcessingTime,
      budgetUtilization
    });

    return {
      collectionsRate: Math.max(0, Math.min(100, Math.round(collectionsRate * 100) / 100)),
      cashFlow: Math.round(netCashFlow * 100) / 100,
      invoiceProcessingTime: Math.round(invoiceProcessingTime * 100) / 100,
      budgetUtilization: Math.max(0, Math.min(100, budgetUtilization)),
    };
  } catch (error) {
    console.error('Error calculating finance metrics:', error);
    return { collectionsRate: 0, cashFlow: 0, invoiceProcessingTime: 0, budgetUtilization: 0 };
  }
}

// HR Department Metrics
async function calculateHRMetrics(startDate, endDate) {
  try {
    // Get employee count
    const employeeCount = await Employee.countDocuments();

    // Get users (active employees)
    const activeUsers = await User.countDocuments({ isActive: true });

    // Calculate attendance rate (mock calculation - in real system, this would come from attendance records)
    const attendanceRate = Math.min(98, 85 + Math.random() * 13);

    // Calculate employee satisfaction (mock - would come from surveys)
    const employeeSatisfaction = Math.min(95, 75 + Math.random() * 20);

    // Calculate training completion rate (mock - would come from training records)
    const trainingCompletion = Math.min(100, 80 + Math.random() * 20);

    return {
      employee_count: employeeCount,
      attendance_rate: Math.round(attendanceRate * 100) / 100,
      employee_satisfaction: Math.round(employeeSatisfaction),
      training_completion_rate: Math.round(trainingCompletion * 100) / 100,
    };
  } catch (error) {
    console.error('Error calculating HR metrics:', error);
    return { employee_count: 0, attendance_rate: 0, employee_satisfaction: 0, training_completion_rate: 0 };
  }
}

// IT Department Metrics
async function calculateITMetrics(startDate, endDate) {
  try {
    // Get IT tickets
    const itDept = await Department.findOne({ name: 'IT' });
    const itTickets = await Ticket.find({
      created_at: { $gte: startDate, $lte: endDate }
    });

    // Calculate tickets resolved
    const resolvedTickets = itTickets.filter(ticket => ticket.status === 'CLOSED').length;

    // Calculate average resolution time
    let totalResolutionTime = 0;
    let validResolutionTimes = 0;

    for (const ticket of itTickets) {
      if (ticket.updated_at && ticket.created_at) {
        const resolutionTime = (ticket.updated_at - ticket.created_at) / (1000 * 60 * 60); // hours
        totalResolutionTime += resolutionTime;
        validResolutionTimes++;
      }
    }

    const averageResolutionTime = validResolutionTimes > 0 ? totalResolutionTime / validResolutionTimes : 0;

    // Mock system uptime (would come from monitoring systems)
    const systemUptime = Math.min(99.9, 95 + Math.random() * 4.9);

    // Mock system performance (would come from performance monitoring)
    const systemPerformance = Math.min(100, 80 + Math.random() * 20);

    return {
      system_uptime: Math.round(systemUptime * 100) / 100,
      tickets_resolved: resolvedTickets,
      average_resolution_time: Math.round(averageResolutionTime * 100) / 100,
      system_performance: Math.round(systemPerformance),
    };
  } catch (error) {
    console.error('Error calculating IT metrics:', error);
    return { system_uptime: 0, tickets_resolved: 0, average_resolution_time: 0, system_performance: 0 };
  }
}

// Auditor Department Metrics
async function calculateAuditorMetrics(startDate, endDate) {
  try {
    // Mock audit data (in real system, this would come from audit records)
    const auditsCompleted = Math.floor(Math.random() * 5) + 3; // 3-7 audits
    const complianceRate = Math.min(100, 85 + Math.random() * 15); // 85-100%
    const riskScore = Math.floor(Math.random() * 30) + 10; // 10-40 (lower is better)
    const findingsCount = Math.floor(Math.random() * 8) + 2; // 2-9 findings

    return {
      audits_completed: auditsCompleted,
      compliance_rate: Math.round(complianceRate * 100) / 100,
      risk_score: riskScore,
      findings_count: findingsCount,
    };
  } catch (error) {
    console.error('Error calculating auditor metrics:', error);
    return { audits_completed: 0, compliance_rate: 0, risk_score: 0, findings_count: 0 };
  }
}

// Management Department Metrics (Company-wide)
async function calculateManagementMetrics(startDate, endDate) {
  try {
    // Get all department metrics
    const salesMetrics = await calculateSalesMetrics(startDate, endDate);
    const operationsMetrics = await calculateOperationsMetrics(startDate, endDate);
    const financeMetrics = await calculateFinanceMetrics(startDate, endDate);
    const hrMetrics = await calculateHRMetrics(startDate, endDate);
    const itMetrics = await calculateITMetrics(startDate, endDate);
    const auditorMetrics = await calculateAuditorMetrics(startDate, endDate);

    // Calculate company-wide metrics
    const totalCompanyRevenue = salesMetrics.total_revenue || 0;
    const totalCompanyShipments = operationsMetrics.total_shipments || 0;
    
    // Calculate customer satisfaction (average of sales client satisfaction and operations delivery rate)
    const customerSatisfaction = Math.round(
      ((salesMetrics.client_satisfaction || 0) + (operationsMetrics.on_time_delivery_rate || 0)) / 2
    );

    // Calculate operational efficiency (average of key operational metrics)
    const operationalEfficiency = Math.round(
      ((operationsMetrics.on_time_delivery_rate || 0) + 
       (financeMetrics.collections_rate || 0) + 
       (hrMetrics.employee_satisfaction || 0) + 
       (itMetrics.system_uptime || 0)) / 4
    );

    // Calculate employee productivity (based on HR and IT metrics)
    const employeeProductivity = Math.round(
      ((hrMetrics.attendance_rate || 0) + 
       (hrMetrics.employee_satisfaction || 0) + 
       (itMetrics.tickets_resolved || 0)) / 3
    );

    // Calculate profit margin (simplified calculation)
    const profitMargin = financeMetrics.collections_rate > 0 ? 
      Math.round((financeMetrics.collections_rate * 0.15)) : 0; // 15% of collection rate

    // Mock market share (would come from market analysis)
    const marketShare = Math.round((15 + Math.random() * 5) * 100) / 100; // 15-20%

    // Calculate risk assessment (inverse of audit risk score)
    const riskAssessment = auditorMetrics.risk_score > 0 ? 
      Math.max(100 - auditorMetrics.risk_score, 0) : 85;

    return {
      total_company_revenue: totalCompanyRevenue,
      total_company_shipments: totalCompanyShipments,
      customer_satisfaction: customerSatisfaction,
      operational_efficiency: operationalEfficiency,
      employee_productivity: employeeProductivity,
      profit_margin: profitMargin,
      market_share: marketShare,
      risk_assessment: riskAssessment,
    };
  } catch (error) {
    console.error('Error calculating management metrics:', error);
    return { 
      total_company_revenue: 0, 
      total_company_shipments: 0, 
      customer_satisfaction: 0, 
      operational_efficiency: 0, 
      employee_productivity: 0, 
      profit_margin: 0, 
      market_share: 0, 
      risk_assessment: 0 
    };
  }
}

module.exports = router;