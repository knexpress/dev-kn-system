const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config();
require('./models/index');

const Booking = mongoose.models.Booking;
const InvoiceRequest = mongoose.models.InvoiceRequest;

const IDENTITY_FIELDS = [
  'philippinesIdBack',
  'philippinesIdFront',
  'customerImage',
  'eidBackImage',
  'eidFrontImage',
  'confirmationForm',
  'tradeLicense',
];

function bytesToMB(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

function escapeRtf(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\line ');
}

async function getCollectionStats(db, collectionName) {
  const stats = await db.command({ collStats: collectionName });
  return {
    collection: collectionName,
    count: stats.count || 0,
    avgObjSize: stats.avgObjSize || 0,
    size: stats.size || 0,
    storageSize: stats.storageSize || 0,
    totalIndexSize: stats.totalIndexSize || 0,
    nindexes: stats.nindexes || 0,
  };
}

async function getLargestDocs(collection, projectionFields = {}, limit = 10) {
  const docs = await collection.aggregate([
    {
      $project: {
        _id: 1,
        size: { $bsonSize: '$$ROOT' },
        ...projectionFields,
      },
    },
    { $sort: { size: -1 } },
    { $limit: limit },
  ]);
  return docs;
}

async function getBase64Totals(collectionName) {
  const projectStage = {};
  const groupStage = { _id: null };

  for (const field of IDENTITY_FIELDS) {
    projectStage[`id_${field}`] = {
      $strLenCP: { $ifNull: [`$identityDocuments.${field}`, ''] },
    };
    groupStage[`id_${field}`] = { $sum: `$id_${field}` };

    if (collectionName === 'invoicerequests') {
      projectStage[`bs_${field}`] = {
        $strLenCP: { $ifNull: [`$booking_snapshot.identityDocuments.${field}`, ''] },
      };
      groupStage[`bs_${field}`] = { $sum: `$bs_${field}` };
    }
  }

  const model = collectionName === 'bookings' ? Booking : InvoiceRequest;
  const rows = await model.aggregate([{ $project: projectStage }, { $group: groupStage }]);
  return rows[0] || groupStage;
}

async function getDuplicationHotspots(limit = 20) {
  const projectStage = {
    _id: 1,
    invoice_number: 1,
    tracking_code: 1,
    status: 1,
    createdAt: 1,
    totalDuplicateBytes: { $literal: 0 },
    duplicatedFields: { $literal: [] },
  };

  for (const field of IDENTITY_FIELDS) {
    const idPath = `$identityDocuments.${field}`;
    const bsPath = `$booking_snapshot.identityDocuments.${field}`;

    const idLen = { $strLenCP: { $ifNull: [idPath, ''] } };
    const bsLen = { $strLenCP: { $ifNull: [bsPath, ''] } };
    const minLen = { $min: [idLen, bsLen] };

    projectStage[`dup_${field}`] = {
      $cond: [{ $and: [{ $gt: [idLen, 0] }, { $gt: [bsLen, 0] }] }, minLen, 0],
    };
  }

  const addTotalStage = {
    $addFields: {
      totalDuplicateBytes: {
        $add: IDENTITY_FIELDS.map((field) => `$dup_${field}`),
      },
      duplicatedFields: {
        $filter: {
          input: IDENTITY_FIELDS.map((field) => ({
            k: field,
            v: `$dup_${field}`,
          })),
          as: 'pair',
          cond: { $gt: ['$$pair.v', 0] },
        },
      },
    },
  };

  const rows = await InvoiceRequest.aggregate([
    { $project: projectStage },
    addTotalStage,
    { $match: { totalDuplicateBytes: { $gt: 0 } } },
    { $sort: { totalDuplicateBytes: -1 } },
    { $limit: limit },
  ]);

  return rows.map((row) => ({
    _id: row._id,
    invoice_number: row.invoice_number || null,
    tracking_code: row.tracking_code || null,
    status: row.status || null,
    createdAt: row.createdAt || null,
    totalDuplicateBytes: row.totalDuplicateBytes || 0,
    totalDuplicateMB: bytesToMB(row.totalDuplicateBytes || 0),
    duplicatedFields: (row.duplicatedFields || []).map((f) => ({
      field: f.k,
      duplicateBytes: f.v,
      duplicateMB: bytesToMB(f.v),
    })),
  }));
}

function buildRtf(report) {
  const lines = [];
  lines.push('{\\rtf1\\ansi\\deff0');
  lines.push('{\\b EMPOST Storage Baseline + Dry-Run Audit Report}\\line');
  lines.push(`Generated At: ${escapeRtf(report.generatedAt)}\\line`);
  lines.push(`Database: ${escapeRtf(report.database)}\\line`);
  lines.push('Mode: DRY-RUN (no database writes)\\line\\line');

  lines.push('{\\b 1) Database Overview}\\line');
  lines.push(`Collections: ${report.databaseStats.collections}, Objects: ${report.databaseStats.objects}\\line`);
  lines.push(`Data Size: ${report.databaseStats.dataSizeMB} MB, Storage Size: ${report.databaseStats.storageSizeMB} MB\\line`);
  lines.push(`Index Size: ${report.databaseStats.indexSizeMB} MB\\line\\line`);

  lines.push('{\\b 2) Collection Cost Breakdown}\\line');
  for (const c of report.collectionBreakdown) {
    lines.push(
      `${escapeRtf(c.collection)} -> docs: ${c.count}, storage: ${c.storageSizeMB} MB, data: ${c.sizeMB} MB, indexes: ${c.totalIndexSizeMB} MB, avgDoc: ${c.avgObjSizeKB} KB\\line`
    );
  }
  lines.push('\\line');

  lines.push('{\\b 3) Base64/Image Footprint Estimate}\\line');
  lines.push(
    `Bookings identityDocuments total: ${report.base64Estimate.bookings.identityDocuments.totalMB} MB\\line`
  );
  lines.push(
    `InvoiceRequests identityDocuments total: ${report.base64Estimate.invoiceRequests.identityDocuments.totalMB} MB\\line`
  );
  lines.push(
    `InvoiceRequests booking_snapshot.identityDocuments total: ${report.base64Estimate.invoiceRequests.bookingSnapshotIdentityDocuments.totalMB} MB\\line`
  );
  lines.push(
    `Potential duplicate risk in InvoiceRequests: ${report.base64Estimate.invoiceRequests.duplicateRiskCombinedMB} MB\\line\\line`
  );

  lines.push('{\\b 4) Top Largest Documents}\\line');
  lines.push('Bookings:\\line');
  for (const d of report.topLargestDocuments.bookings) {
    lines.push(`- ${d._id} | ${d.sizeMB} MB | review_status=${escapeRtf(d.review_status || 'N/A')}\\line`);
  }
  lines.push('\\lineInvoiceRequests:\\line');
  for (const d of report.topLargestDocuments.invoiceRequests) {
    lines.push(
      `- ${d._id} | ${d.sizeMB} MB | invoice=${escapeRtf(d.invoice_number || 'N/A')} | status=${escapeRtf(d.status || 'N/A')}\\line`
    );
  }
  lines.push('\\line');

  lines.push('{\\b 5) Duplication Hotspots (InvoiceRequests)}\\line');
  for (const h of report.duplicationHotspots) {
    const fields = h.duplicatedFields.map((f) => `${f.field}:${f.duplicateMB}MB`).join(', ');
    lines.push(
      `- ${h._id} | invoice=${escapeRtf(h.invoice_number || 'N/A')} | dup=${h.totalDuplicateMB} MB | fields: ${escapeRtf(fields)}\\line`
    );
  }
  lines.push('\\line');

  lines.push('{\\b 6) Safe Removal Estimate (Dry-Run)}\\line');
  lines.push(
    `Primary safe target: invoiceRequests.booking_snapshot.identityDocuments (~${report.safeRemovalEstimate.primaryTargetMB} MB)\\line`
  );
  lines.push(
    `Secondary target (after validation): invoiceRequests.identityDocuments duplicates (~${report.safeRemovalEstimate.secondaryTargetMB} MB)\\line`
  );
  lines.push('}');
  return lines.join('\n');
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI not found in environment variables.');
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const dbStatsRaw = await db.stats();
  const bookingStats = await getCollectionStats(db, 'bookings');
  const invoiceRequestStats = await getCollectionStats(db, 'invoicerequests');

  const topBookings = await getLargestDocs(
    Booking,
    { review_status: 1, createdAt: 1 },
    15
  );
  const topInvoiceRequests = await getLargestDocs(
    InvoiceRequest,
    { invoice_number: 1, status: 1, tracking_code: 1, createdAt: 1 },
    15
  );

  const bookingBase64 = await getBase64Totals('bookings');
  const invoiceRequestBase64 = await getBase64Totals('invoicerequests');
  const hotspots = await getDuplicationHotspots(30);

  const bookingIdentityTotalBytes = IDENTITY_FIELDS.reduce(
    (sum, key) => sum + (bookingBase64[`id_${key}`] || 0),
    0
  );

  const invoiceIdentityTotalBytes = IDENTITY_FIELDS.reduce(
    (sum, key) => sum + (invoiceRequestBase64[`id_${key}`] || 0),
    0
  );

  const snapshotIdentityTotalBytes = IDENTITY_FIELDS.reduce(
    (sum, key) => sum + (invoiceRequestBase64[`bs_${key}`] || 0),
    0
  );

  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'dry-run',
    database: db.databaseName,
    databaseStats: {
      collections: Number(dbStatsRaw.collections || 0),
      objects: Number(dbStatsRaw.objects || 0),
      dataSize: dbStatsRaw.dataSize || 0,
      dataSizeMB: bytesToMB(dbStatsRaw.dataSize || 0),
      storageSize: dbStatsRaw.storageSize || 0,
      storageSizeMB: bytesToMB(dbStatsRaw.storageSize || 0),
      indexSize: dbStatsRaw.indexSize || 0,
      indexSizeMB: bytesToMB(dbStatsRaw.indexSize || 0),
      totalSize: dbStatsRaw.totalSize || 0,
      totalSizeMB: bytesToMB(dbStatsRaw.totalSize || 0),
    },
    collectionBreakdown: [bookingStats, invoiceRequestStats].map((c) => ({
      collection: c.collection,
      count: c.count,
      avgObjSize: c.avgObjSize,
      avgObjSizeKB: Number((c.avgObjSize / 1024).toFixed(2)),
      size: c.size,
      sizeMB: bytesToMB(c.size),
      storageSize: c.storageSize,
      storageSizeMB: bytesToMB(c.storageSize),
      totalIndexSize: c.totalIndexSize,
      totalIndexSizeMB: bytesToMB(c.totalIndexSize),
      nindexes: c.nindexes,
    })),
    base64Estimate: {
      bookings: {
        identityDocuments: {
          byFieldBytes: Object.fromEntries(
            IDENTITY_FIELDS.map((k) => [k, bookingBase64[`id_${k}`] || 0])
          ),
          totalBytes: bookingIdentityTotalBytes,
          totalMB: bytesToMB(bookingIdentityTotalBytes),
        },
      },
      invoiceRequests: {
        identityDocuments: {
          byFieldBytes: Object.fromEntries(
            IDENTITY_FIELDS.map((k) => [k, invoiceRequestBase64[`id_${k}`] || 0])
          ),
          totalBytes: invoiceIdentityTotalBytes,
          totalMB: bytesToMB(invoiceIdentityTotalBytes),
        },
        bookingSnapshotIdentityDocuments: {
          byFieldBytes: Object.fromEntries(
            IDENTITY_FIELDS.map((k) => [k, invoiceRequestBase64[`bs_${k}`] || 0])
          ),
          totalBytes: snapshotIdentityTotalBytes,
          totalMB: bytesToMB(snapshotIdentityTotalBytes),
        },
        duplicateRiskCombinedBytes: invoiceIdentityTotalBytes + snapshotIdentityTotalBytes,
        duplicateRiskCombinedMB: bytesToMB(invoiceIdentityTotalBytes + snapshotIdentityTotalBytes),
      },
    },
    topLargestDocuments: {
      bookings: topBookings.map((d) => ({
        _id: d._id,
        sizeBytes: d.size,
        sizeMB: bytesToMB(d.size),
        review_status: d.review_status || null,
        createdAt: d.createdAt || null,
      })),
      invoiceRequests: topInvoiceRequests.map((d) => ({
        _id: d._id,
        sizeBytes: d.size,
        sizeMB: bytesToMB(d.size),
        invoice_number: d.invoice_number || null,
        tracking_code: d.tracking_code || null,
        status: d.status || null,
        createdAt: d.createdAt || null,
      })),
    },
    duplicationHotspots: hotspots,
    safeRemovalEstimate: {
      primaryTargetBytes: snapshotIdentityTotalBytes,
      primaryTargetMB: bytesToMB(snapshotIdentityTotalBytes),
      secondaryTargetBytes: invoiceIdentityTotalBytes,
      secondaryTargetMB: bytesToMB(invoiceIdentityTotalBytes),
      note: 'Primary target is booking_snapshot.identityDocuments in InvoiceRequests because it is duplicate snapshot data.',
    },
  };

  const ts = Date.now();
  const jsonPath = path.join(process.cwd(), `storage-audit-dry-run-${ts}.json`);
  const rtfPath = path.join(process.cwd(), `storage-audit-dry-run-${ts}.rtf`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(rtfPath, buildRtf(report), 'utf8');

  console.log('✅ Dry-run audit completed (no DB writes).');
  console.log(`📄 JSON report: ${jsonPath}`);
  console.log(`📄 Word-compatible report (.rtf): ${rtfPath}`);
}

main()
  .catch((error) => {
    console.error('❌ Dry-run audit failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (e) {
      // no-op
    }
  });

