const mongoose = require('mongoose');

const HREF_BY_TYPE = {
  invoice_request: '/dashboard/invoice-requests',
  quotation_request: '/dashboard/quotations',
  invoice: '/dashboard/accounting',
  collection: '/dashboard/accounting',
  request: '/dashboard/requests',
  ticket: '/dashboard',
  chat: '/dashboard',
};

const COUNT_KEY_BY_TYPE = {
  invoice: 'invoices',
  invoice_request: 'invoiceRequests',
  quotation_request: 'invoiceRequests',
  collection: 'collections',
  request: 'requests',
  ticket: 'tickets',
  chat: 'chat',
};

const TYPES_BY_COUNT_KEY = {
  invoices: ['invoice'],
  invoiceRequests: ['invoice_request', 'quotation_request'],
  collections: ['collection'],
  requests: ['request'],
  tickets: ['ticket'],
  chat: ['chat'],
};

function models() {
  return require('../models');
}

function asId(value) {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

function isActor(user, actorId) {
  if (!actorId || !user) return false;
  const id = asId(actorId);
  return asId(user._id) === id || asId(user.employee_id) === id;
}

function shipmentLabel(doc) {
  const awb = doc?.tracking_code || doc?.awb_number || doc?.invoice_number || '';
  const customer = doc?.customer_name || doc?.client_name || 'Customer';
  return {
    awb,
    customer,
    label: awb ? `AWB ${awb} · ${customer}` : customer,
  };
}

async function resolveDepartments(namesOrIds = []) {
  const { Department } = models();
  const values = (Array.isArray(namesOrIds) ? namesOrIds : [namesOrIds]).filter(Boolean);
  if (!values.length) return [];

  const ids = [];
  const names = [];
  values.forEach((value) => {
    const raw = asId(value);
    if (mongoose.Types.ObjectId.isValid(raw) && String(new mongoose.Types.ObjectId(raw)) === raw) {
      ids.push(raw);
    } else {
      names.push(raw);
    }
  });

  const query = [];
  if (ids.length) query.push({ _id: { $in: ids } });
  if (names.length) {
    query.push({
      name: { $in: names.map((name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')) },
    });
  }

  return Department.find(query.length === 1 ? query[0] : { $or: query }).select('_id name').lean();
}

async function recipientsForDepartments(departments, actorId) {
  const { User } = models();
  const deptDocs = await resolveDepartments(departments);
  const deptIds = deptDocs.map((dept) => dept._id);

  const query = {
    isActive: { $ne: false },
    $or: [
      ...(deptIds.length ? [{ department_id: { $in: deptIds } }] : []),
      { role: { $in: ['SUPERADMIN'] } },
    ],
  };

  if (!query.$or.length) return [];

  const users = await User.find(query).select('_id department_id employee_id role').lean();
  const unique = new Map();
  users.forEach((user) => {
    if (isActor(user, actorId)) return;
    unique.set(asId(user._id), user);
  });
  return Array.from(unique.values());
}

async function describeItem(type, itemId) {
  const { InvoiceRequest, Collections, Ticket, Request } = models();
  const href = HREF_BY_TYPE[type] || '/dashboard';

  if (type === 'invoice_request' || type === 'quotation_request') {
    const doc = await InvoiceRequest.findById(itemId).select('tracking_code awb_number invoice_number customer_name').lean();
    const { label } = shipmentLabel(doc || {});
    if (type === 'quotation_request') {
      return { title: 'New quotation request', message: `${label} needs a quotation.`, href };
    }
    return { title: 'New invoice request', message: `${label} is waiting for the next department.`, href };
  }

  if (type === 'collection') {
    const doc = await Collections.findById(itemId).select('invoice_id client_name').lean();
    return {
      title: 'New collection',
      message: `${doc?.invoice_id || 'Invoice'} · ${doc?.client_name || 'Customer'} is ready to collect.`,
      href,
    };
  }

  if (type === 'ticket') {
    const doc = await Ticket.findById(itemId).select('title').lean();
    return { title: 'New ticket', message: doc?.title || 'A support ticket was opened.', href };
  }

  if (type === 'request') {
    const doc = await Request.findById(itemId).select('awb_number').lean();
    return {
      title: 'New request',
      message: doc?.awb_number ? `AWB ${doc.awb_number} was assigned to your department.` : 'A request was assigned to your department.',
      href,
    };
  }

  if (type === 'invoice') {
    return { title: 'New invoice', message: 'An invoice was generated.', href };
  }

  return { title: 'New notification', message: 'You have a new update.', href };
}

async function notify({ departments, type, title, message, href, itemId, actorId }) {
  try {
    const { Notification } = models();
    const users = await recipientsForDepartments(departments, actorId);
    if (!users.length) return 0;

    const docs = users.map((user) => ({
      user_id: user._id,
      department_id: user.department_id,
      type,
      title,
      message,
      href: href || HREF_BY_TYPE[type] || '/dashboard',
      item_id: itemId || undefined,
      is_read: false,
    }));

    await Notification.insertMany(docs, { ordered: false });
    return docs.length;
  } catch (error) {
    console.error('Failed to create notifications:', error.message);
    return 0;
  }
}

async function createNotificationsForDepartment(type, itemId, departmentId, actorId) {
  const extras = await describeItem(type, itemId);
  return notify({
    departments: [departmentId],
    type,
    title: extras.title,
    message: extras.message,
    href: extras.href,
    itemId,
    actorId,
  });
}

async function createNotificationsForAllUsers(type, itemId, actorId) {
  try {
    const { User, Notification } = models();
    const extras = await describeItem(type, itemId);
    const users = await User.find({ isActive: { $ne: false } }).select('_id department_id employee_id').lean();
    const docs = users
      .filter((user) => !isActor(user, actorId))
      .map((user) => ({
        user_id: user._id,
        department_id: user.department_id,
        type,
        title: extras.title,
        message: extras.message,
        href: extras.href,
        item_id: itemId || undefined,
        is_read: false,
      }));
    if (!docs.length) return 0;
    await Notification.insertMany(docs, { ordered: false });
    return docs.length;
  } catch (error) {
    console.error('Failed to create notifications for all users:', error.message);
    return 0;
  }
}

const HANDOFF_EVENTS = {
  submitted: {
    departments: ['Operations'],
    type: 'invoice_request',
    title: 'New invoice request',
    href: '/dashboard/invoice-requests',
    message: (label) => `${label} is waiting for Operations.`,
  },
  quotation_requested: {
    departments: ['Finance'],
    type: 'quotation_request',
    title: 'New quotation request',
    href: '/dashboard/quotations',
    message: (label) => `${label} needs a quotation from Operations.`,
  },
  sent_to_operations: {
    departments: ['Operations'],
    type: 'invoice_request',
    title: 'Quotation sent to Operations',
    href: '/dashboard/invoice-requests',
    message: (label) => `${label} is ready to process.`,
  },
  verified: {
    departments: ['Finance'],
    type: 'invoice_request',
    title: 'Shipment verified',
    href: '/dashboard/invoice-requests',
    message: (label) => `${label} is ready for invoice generation.`,
  },
  completed: {
    departments: ['Sales'],
    type: 'invoice_request',
    title: 'Invoice generated',
    href: '/dashboard/invoice-requests',
    message: (label) => `${label} has been invoiced.`,
  },
  cancelled: {
    departments: ['Sales', 'Operations', 'Finance'],
    type: 'invoice_request',
    title: 'Shipment cancelled',
    href: '/dashboard/invoice-requests',
    message: (label) => `${label} was cancelled.`,
  },
};

async function notifyInvoiceRequestEvent(invoiceRequest, event, actorId) {
  const spec = HANDOFF_EVENTS[event];
  if (!spec || !invoiceRequest) return 0;
  const { label } = shipmentLabel(invoiceRequest);
  return notify({
    departments: spec.departments,
    type: spec.type,
    title: spec.title,
    message: spec.message(label),
    href: spec.href,
    itemId: invoiceRequest._id,
    actorId,
  });
}

function typesForCountKey(key) {
  return TYPES_BY_COUNT_KEY[key] || [];
}

function countKeyForType(type) {
  return COUNT_KEY_BY_TYPE[type] || 'requests';
}

module.exports = {
  notify,
  createNotificationsForDepartment,
  createNotificationsForAllUsers,
  notifyInvoiceRequestEvent,
  typesForCountKey,
  countKeyForType,
};
