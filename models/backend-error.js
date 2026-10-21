const mongoose = require('mongoose');

const backendErrorSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    stackTrace: {
      type: String,
      default: '',
    },
    timestamp: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    isSolved: {
      type: Boolean,
      required: true,
      default: false,
      index: true,
    },
    environment: {
      type: String,
      required: true,
      default: 'production',
      trim: true,
      index: true,
    },
    errorType: {
      type: String,
      required: true,
      default: 'runtime',
      trim: true,
    },
    source: {
      type: String,
      required: true,
      default: 'api',
      trim: true,
    },
    fileName: {
      type: String,
      default: '',
      trim: true,
    },
    lineNumber: {
      type: Number,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: 'backend_errors',
  }
);

backendErrorSchema.index({ timestamp: -1 });
backendErrorSchema.index({ environment: 1, isSolved: 1, timestamp: -1 });

module.exports =
  mongoose.models.BackendError ||
  mongoose.model('BackendError', backendErrorSchema);

