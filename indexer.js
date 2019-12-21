'use strict';

require('barrkeep/pp');
const fs = require('fs');
const os = require('os');
const async = require('async');
const uuid = require('uuid/v4');
const { join } = require('path');
const { format } = require('util');
const Scanner = require('./scanner');
const utils = require('barrkeep/utils');
const style = require('barrkeep/style');
const MongoClient = require('mongodb').MongoClient;
const {
  ProgressBar, Spinner
} = require('barrkeep/progress');
const {
  execFile, spawn
} = require('child_process');

const version = require('./package.json').version;

//////////

const durationRegExp = /Duration:\s(\d+:\d+:\d+\.\d+)/;
const timeRegExp = /time=(\d+:\d+:\d+\.\d+)/;

function timeToValue (string) {
  const parts = string.split(/:/);

  let value = Number.parseInt(parts[0], 10) * 3600000;
  value += Number.parseInt(parts[1], 10) * 60000;
  value += Math.ceil(Number.parseFloat(parts[2]) * 1000);

  return value;
}

//////////

const defaults = {
  name: `Indexer v${ version }`,
  scan: process.cwd(),
  pattern: /\.(asf|avi|flv|mkv|mpg|mp4|m4v|webm|wmv|3gp)$/i,
  db: 'mongodb://localhost:27017/indexer',
  concurrency: 2,
  shasum: '/usr/bin/sha1sum',
  ffmpeg: '/usr/bin/ffmpeg',
  convert: '-i $input -f $format -vcodec libx264 -preset fast' +
    ' -profile:v main -acodec aac $output -hide_banner -y',
  format: 'mp4',
  thumbnailFormat: 'png',
  thumbnail: '-i $output -ss 00:00:03.000 -vframes 1 $thumbnail -y',
  sound: '-t 10 -i $file -af volumedetect -f null /dev/null',
  ffprobe: '/usr/bin/ffprobe',
  probe: '-v quiet -print_format json -show_format -show_streams -print_format json $file',
  save: join(os.tmpdir(), 'indexer'),
  delete: false,
  tagger: (model) => {
    if (model.tags.length === 0) {
      model.tags.push('untagged');
    }
  },
  log: join(process.cwd(), 'indexer.log')
};

class Indexer {
  constructor (options = {}) {
    this.config = utils.merge(defaults, options);

    if (typeof this.config.tagger === 'function') {
      this.tagger = this.config.tagger;
    }

    if (this.config.log) {
      this.logStream = fs.createWriteStream(this.config.log, {
        flags: 'a',
        autoclsoe: true
      });

      this.log = (...args) => { this.logStream.write(`${ format(...args) }\n`); };
    } else {
      this.log = () => {};
    }

    this.slots = new Array(this.config.concurrency);

    this.queue = async.queue(this.converter.bind(this), this.config.concurrency);

    this.queue.error((error, task) => {
      this.log(` x error in processing ${ task }`);
      this.log(error);

      if (this.progress) {
        this.progress.total--;
        this.tokens.processed++;
      }
    });

    process.on('SIGINT', () => {
      console.log('\x1b[H\x1b[2J\x1b[?25hCanceled.');
      process.exit(0);
    });

    this.tokens = {
      left: style('[', 'fg: grey; style: bold'),
      right: style(']', 'fg: grey; style: bold'),
      files: 0,
      processed: 0
    };
  }

  model ({
    id, original, output, converted, thumbnail, info, sound
  }) {
    let duration;
    let aspect;
    let width;
    let height;

    if (info.format && info.format.duration) {
      duration = info.format.duration;
    }

    for (const stream of info.streams) {
      if (stream.display_aspect_ratio) {
        aspect = stream.display_aspect_ratio;
      }
      if (stream.width) {
        width = stream.width;
      }
      if (stream.height) {
        height = stream.height;
      }
    }

    const model = {
      id,
      hash: original.hash,
      relative: output.replace(this.config.save, '').replace(/^\//, ''),
      thumbnail: thumbnail.replace(this.config.save, '').replace(/^\//, ''),
      size: converted.size,
      duration,
      aspect,
      width,
      height,
      sound,
      timestamp: new Date(converted.mtime).getTime(),
      metadata: {
        original,
        duplicates: []
      },
      tags: [ ]
    };

    if (this.tagger) {
      this.tagger(model);
    }

    return model;
  }

  lookup (hash, callback) {
    return this.media.findOne({ hash }, callback);
  }

  converter (file, callback) {
    let index;
    for (index = 0; index < this.slots.length; index++) {
      if (!this.slots[index]) {
        this.slots[index] = true;
        break;
      }
    }
    const y = 5 + index * 2;

    this.log(` * examining ${ file }`);
    return fs.stat(file, (error, stat) => {
      if (error) {
        return callback(error);
      }

      const [ , name, extension ] = file.match(/([^/]+)\.([^.]+)$/);
      const shortName = name.length > 25 ? `${ name.substring(0, 22) }…` : name;

      const prettyName = style(`${ name }.${ extension }`, 'style: bold');
      const prettyShortName = style(`${ shortName }.${ extension }`, 'style: bold');

      let spinner = new Spinner({
        prepend: `  Fingerprinting ${ prettyName } `,
        spinner: 'dots4',
        style: 'fg: DodgerBlue1',
        x: 0,
        y
      });
      spinner.start();

      this.log(` * hashing ${ file }`);
      return execFile(this.config.shasum, [ file ], (error, sha) => {
        spinner.stop();

        if (error) {
          return callback(error);
        }

        const [ hash ] = sha.trim().split(/\s+/);

        this.log(` * hashed ${ file }: ${ hash }`);

        const original = {
          hash,
          file,
          path: file.replace(/\/([^/]+)$/, '/'),
          name,
          extension,
          size: stat.size,
          timestamp: new Date(stat.mtime).getTime()
        };

        return this.lookup(hash, (error, item) => {
          if (error) {
            return callback(error);
          }

          if (item) {
            this.log(`  - match for ${ hash } found`);
            item.metadata.duplicates.push(original);
            return this.media.updateOne({ id: item.id }, { $set: item }, (error) => {
              if (error) {
                return callback(error);
              }

              if (this.config.delete) {
                return fs.unlink(file, (error) => {
                  if (error) {
                    return callback(error);
                  }
                  this.progress.total--;
                  this.tokens.processed++;
                  this.slots[index] = false;
                  return callback(null, item);
                });
              }
              this.progress.total--;
              this.tokens.processed++;
              this.slots[index] = false;
              return callback(null, item);
            });
          }

          const id = uuid();

          const directory = join(this.config.save, id.substring(0, 2));
          const filename = id.substring(2).replace(/-/g, '');

          const output = join(directory, `${ filename }.${ this.config.format }`);

          return fs.mkdir(directory, { recursive: true }, (error) => {
            if (error) {
              return callback(error);
            }

            const convertArgs = this.config.convert.
              trim().
              split(/\s+/).
              map((arg) => {
                return arg.replace('$input', file).
                  replace('$output', output).
                  replace('$format', this.config.format);
              });

            this.log(` * converting ${ name }.${ extension } in slot ${ index }`);

            const progress = new ProgressBar({
              format: `  Converting ${ prettyShortName } $left$progress$right ` +
                '$percent ($eta remaining)',
              total: Infinity,
              width: 40,
              y,
              complete: style('━', 'fg: Green4'),
              head: style('▶', 'fg: Green4'),
              clear: true,
              tokens: this.tokens
            });

            const convert = spawn(this.config.ffmpeg, convertArgs,
              { stdio: [ 'ignore', 'ignore', 'pipe' ] });

            let log = '';
            convert.stderr.on('data', (data) => {
              data = data.toString();
              log += data;

              if (progress.total === Infinity && durationRegExp.test(log)) {
                const [ , duration ] = log.match(durationRegExp);
                progress.total = timeToValue(duration);
              } else if (timeRegExp.test(data)) {
                const [ , time ] = data.match(timeRegExp);
                progress.value = timeToValue(time);
              }
            });

            convert.on('exit', (code) => {
              progress.done();

              if (code !== 0) {
                this.log(` ! failed to convert ${ name }.${ extension }`);
                return callback(new Error(`Failed to convert ${ name }.${ extension }`));
              }

              this.log(` * converted ${ name }.${ extension }!`);

              spinner = new Spinner({
                prepend: `  Generating metadata for ${ prettyName } `,
                spinner: 'dots4',
                style: 'fg: DodgerBlue1',
                x: 0,
                y
              });
              spinner.start();

              const thumbnail = output.replace(this.config.format, this.config.thumbnailFormat);
              const thumbnailArgs = this.config.thumbnail.
                trim().
                split(/\s+/).
                map((arg) => {
                  return arg.replace('$output', output).
                    replace('$thumbnail', thumbnail);
                });

              this.log(` * generating thumbnail ${ thumbnail }`);

              return execFile(this.config.ffmpeg, thumbnailArgs, (error) => {
                if (error) {
                  return callback(error);
                }

                this.log(` * generated thumbnail ${ thumbnail }`);

                return fs.stat(output, (error, converted) => {
                  if (error) {
                    return callback(error);
                  }

                  this.log(` * probing converted file information for ${ output }`);

                  const probeArgs = this.config.probe.
                    trim().
                    split(/\s+/).
                    map((arg) => {
                      return arg.replace('$file', output);
                    });

                  return execFile(this.config.ffprobe, probeArgs, (error, info) => {
                    if (error) {
                      return callback(error);
                    }

                    info = JSON.parse(info);

                    this.log(` * obtained info for ${ output }`);

                    this.log(` * checking for sound in ${ output }`);

                    const soundArgs = this.config.sound.
                      trim().
                      split(/\s+/).
                      map((arg) => {
                        return arg.replace('$file', output);
                      });

                    return execFile(this.config.ffmpeg, soundArgs, (error, stdout, soundInfo) => {
                      if (error) {
                        return callback(error);
                      }

                      const sound = !soundInfo.includes('mean_volume: -91');

                      this.log(` * sound in ${ output }: ${ sound }`);

                      const model = this.model({
                        id,
                        original,
                        output,
                        converted,
                        thumbnail,
                        info,
                        sound
                      });

                      this.log(` - inserting ${ name } / ${ id } into db`);

                      return this.media.insertOne(model, (error) => {
                        if (error) {
                          return callback(error);
                        }

                        this.log(` - inserted ${ name } / ${ id } into db`);

                        if (this.config.delete) {
                          this.log(` - deleting ${ file }`);

                          return fs.unlink(file, (error) => {
                            if (error) {
                              return callback(error);
                            }

                            this.log(` - deleted ${ file }`);

                            spinner.stop();
                            this.progress.value++;
                            this.tokens.processed++;
                            this.slots[index] = false;
                            return callback(null, model);
                          });
                        }

                        spinner.stop();
                        this.progress.value++;
                        this.tokens.processed++;
                        this.slots[index] = false;
                        return callback(null, model);
                      });
                    });
                  });
                });
              });
            });

            return convert;
          });
        });
      });
    });
  }

  scan (callback) {
    this.log(' - scanning...');

    this.progress = new ProgressBar({
      format: ' Processed $processed/$files files $left$progress$right ' +
        '$percent ($eta remaining) $spinner',
      total: 1,
      width: 40,
      y: 3,
      complete: style('◼', 'fg: Green4'),
      head: false,
      spinner: 'dots',
      spinnerStyle: 'fg: DodgerBlue1',
      clear: true,
      tokens: this.tokens,
      formatOptions: { numeral: true }
    });

    this.scanner = new Scanner(this.config);

    this.scanner.on('file', (event) => {
      if (event.data.index !== 1) {
        this.progress.total++;
      }
      this.tokens.files++;
      this.queue.push(event.data.path);
    });

    this.scanner.add(this.config.scan);

    return this.queue.drain(() => {
      console.log('\x1b[H\x1b[2J\x1b[?25hDone.');
      return callback();
    });
  }

  start (callback) {
    callback = utils.callback(callback);

    console.log(`\x1b[H\x1b[2J\n${ this.config.name } starting up...`);

    this.client = new MongoClient(this.config.db, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    this.log(` - connecting to ${ this.config.db }...`);
    return this.client.connect((error) => {
      if (error) {
        return callback(error);
      }

      this.db = this.client.db();
      this.media = this.db.collection('media');

      return this.scan((error) => {
        if (error) {
          return callback(error);
        }

        return this.client.close(callback);
      });
    });
  }
}

module.exports = Indexer;
