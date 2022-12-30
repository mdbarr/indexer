'use strict';

const util = require('node:util');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const childProcess = require('node:child_process');

const gzip = util.promisify(zlib.gzip);
const brotli = util.promisify(zlib.brotliCompress);
const execFile = util.promisify(childProcess.execFile);

async function brotliFile (input, output) {
  const buffer = await fs.readFile(input);
  const compressed = await brotli(buffer);
  await fs.writeFile(output, compressed);
}

async function gzipFile (input, output) {
  const buffer = await fs.readFile(input);
  const compressed = await gzip(buffer);
  await fs.writeFile(output, compressed);
}

async function safeChmod (file, mode) {
  try {
    await fs.chmod(file, mode);
  } catch (error) {
    // no error
  }
}

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

function md5sum (content) {
  return crypto.createHash('md5').
    update(content).
    digest('hex');
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
  brotli,
  brotliFile,
  execFile,
  gzip,
  gzipFile,
  md5sum,
  safeChmod,
  safeExecFile,
  safeRmdir,
  safeStat,
  safeUnlink,
  spawn,
};
