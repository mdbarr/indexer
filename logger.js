'use strict';

const fs = require('node:fs');
const winston = require('winston');

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(info => `[${ info.timestamp }] ${ info.level }: ${ info.message }`));

function safeUnlinkSync (path) {
  try {
    fs.unlinkSync(path);
  } catch (error) {
    // No error
  }
}

module.exports = (config = {}) => {
  const logger = winston.createLogger({ level: config.level || 'info' });

  if (config.console) {
    logger.add(new winston.transports.Console({ format: logFormat }));
  }

  if (config.combined) {
    if (config.clear) {
      safeUnlinkSync(config.combined);
    }

    logger.add(new winston.transports.File({
      format: logFormat,
      filename: config.combined,
    }));
  }

  if (config.error) {
    if (config.clear) {
      safeUnlinkSync(config.error);
    }

    logger.add(new winston.transports.File({
      format: logFormat,
      filename: config.error,
      level: 'error',
    }));
  }

  return logger;
};
