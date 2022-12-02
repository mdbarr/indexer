'use strict';

const fs = require('fs/promises');
const util = require('node:util');
const childProcess = require('node:child_process');
const execFile = util.promisify(childProcess.execFile);

async function safeExecFile (file, args, options) {
  try {
    const result = await execFile(file, args, options);
    return result;
  } catch (error) {
    return { error };
  }
}

async function safeRmdir (path) {
  try {
    await fs.rmdir(path);
  } catch (error) {
    // no error
  }
}

async function safeStat (path) {
  try {
    const result = await fs.stat(path);
    return result;
  } catch (error) {
    return null;
  }
}

async function safeUnlink (file) {
  try {
    await fs.unlink(file);
  } catch (error) {
    // no error
  }
}

async function spawn (command, args, options, handlers = {}) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(command, args, options);

    if (handlers.disconnect) {
      child.on('disconnect', handlers.disconnect);
    }
    if (handlers.error) {
      child.on('error', handlers.error);
    }
    if (handlers.message) {
      child.on('message', handlers.message);
    }
    if (handlers.spawn) {
      child.on('spawn', handlers.spawn);
    }
    if (handlers.stderr) {
      child.stderr.on('data', handlers.stderr);
    }
    if (handlers.stdout) {
      child.stdout.on('data', handlers.stdout);
    }

    child.on('close', (code) => resolve(code));
  });
}

module.exports = {
  execFile,
  safeExecFile,
  safeRmdir,
  safeStat,
  safeUnlink,
  spawn,
};
