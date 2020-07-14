'use strict';

const winston = require('winston');

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(info => `[${ info.timestamp }] ${ info.level }: ${ info.message }`));

module.exports = (config = {}) => {
  const logger = winston.createLogger({ level: config.level || 'info' });

  if (config.console) {
    logger.add(new winston.transports.Console({ format: logFormat }));
  }

  if (config.combined) {
    logger.add(new winston.transports.File({
      format: logFormat,
      filename: config.combined,
    }));
  }

  if (config.error) {
    logger.add(new winston.transports.File({
      format: logFormat,
      filename: config.error,
      level: 'error',
    }));
  }

  return logger;
};
