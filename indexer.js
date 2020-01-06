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

function hasSubtitles (details) {
  let subtitles = false;
  for (const stream of details.streams) {
    if (stream.codec_type === 'subtitle') {
      subtitles = true;
      break;
    }
  }
  return subtitles;
}

//////////

const defaults = {
  name: `Indexer v${ version }`,
  scan: process.cwd(),
  pattern: /\.(asf|avi|flv|mkv|mov|mpg|mp4|mts|m4v|ts|vob|webm|wmv|3gp)$/i,
  db: 'mongodb://localhost:27017/indexer',
  concurrency: 2,
  shasum: '/usr/bin/md5sum',
  ffmpeg: '/usr/bin/ffmpeg',
  convert: '-i $input -f $format -vcodec libx264 -preset fast' +
    ' -profile:v main -acodec aac $output -hide_banner -y',
  convertSubtitles: '-i $input -f $format -vcodec libx264 -preset fast' +
    ' -profile:v main -acodec aac -vf subtitles=$input $output -hide_banner -y',
  format: 'mp4',
  thumbnailFormat: 'png',
  thumbnail: '-i $output -ss 00:00:05.000 -vframes 1 $thumbnail -y',
  sound: '-t 10 -i $file -af volumedetect -f null /dev/null',
  preview: "-i $input -vf select='lt(mod(t,$interval),1)',setpts=N/FRAME_RATE/TB" +
    ' -an $output -y -hide_banner',
  previewFormat: 'webm',
  previewInterval: 60,
  ffprobe: '/usr/bin/ffprobe',
  probe: '-v quiet -print_format json -show_format -show_streams -print_format json $file',
  save: join(os.tmpdir(), 'indexer'),
  checkSound: true,
  delete: false,
  tagger: (model, config) => {
    if (config.dropTags) {
      model.metadata.tags = [];
    }
    if (model.metadata.tags.length === 0) {
      model.metadata.tags.push('untagged');
    }

    if (config.dropCategories) {
      model.metadata.categories = [];
    }
    if (model.metadata.categories.length === 0) {
      model.metadata.categories.push('uncategorized');
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
        autoclose: true
      });

      this.log = (...args) => { this.logStream.write(`${ format(...args) }\n`); };
    } else {
      this.log = () => {};
    }

    this.slots = new Array(this.config.concurrency);

    this.queue = async.queue((file, callback) => {
      const slot = {};

      for (let index = 0; index < this.slots.length; index++) {
        if (!this.slots[index]) {
          this.slots[index] = true;
          slot.index = index;
          break;
        }
      }
      slot.y = 5 + slot.index * 2;

      return this.converter({
        file,
        slot
      }, (error) => {
        this.slots[slot.index] = false;
        if (slot.spinner && slot.spinner.stop) {
          slot.spinner.stop();
        }

        if (slot.progress && slot.progress.done) {
          slot.progress.done();
        }

        return callback(error);
      });
    }, this.config.concurrency);

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
    id, occurrence, output, converted, thumbnail, preview, info, sound
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

    const timestamp = Date.now();

    const model = {
      id,
      object: 'video',
      version,
      name: occurrence.name,
      hash: occurrence.hash,
      relative: output.replace(this.config.save, '').replace(/^\//, ''),
      thumbnail: thumbnail.replace(this.config.save, '').replace(/^\//, ''),
      preview: preview.replace(this.config.save, '').replace(/^\//, ''),
      size: converted.size,
      duration,
      aspect,
      width,
      height,
      sound,
      metadata: {
        created: new Date(converted.mtime).getTime(),
        added: timestamp,
        updated: timestamp,
        occurrences: [ occurrence ],
        series: false,
        views: 0,
        stars: 0,
        favorited: false,
        reviewed: false,
        private: false,
        description: '',
        categories: [ ],
        tags: [ ]
      }
    };

    if (this.tagger) {
      this.log(` - tagging ${ occurrence.name }`);
      this.tagger(model, this.config);
      model.metadata.updated = Date.now();
    }

    return model;
  }

  lookup (hash, callback) {
    return this.media.findOne({ hash }, callback);
  }

  examine (file, callback) {
    this.log(` * examining ${ file }`);
    return fs.stat(file, (error, stat) => {
      if (error) {
        return callback(error);
      }

      this.log(` * probing detailed information for ${ file }`);

      const probeArgs = this.config.probe.
        trim().
        split(/\s+/).
        map((arg) => {
          return arg.replace('$file', file);
        });

      return execFile(this.config.ffprobe, probeArgs, (error, info) => {
        if (error) {
          return callback(error);
        }

        try {
          info = JSON.parse(info);
        } catch (exception) {
          info = null;
          error = exception;
        }

        return callback(error, stat, info);
      });
    });
  }

  delete (file, callback) {
    if (this.config.delete) {
      this.log(` - deleting ${ file }`);

      return fs.unlink(file, (error) => {
        if (error) {
          return callback(error);
        }
        this.log(` - deleted ${ file }`);

        return callback(null);
      });
    }
    return setImmediate(callback);
  }

  preview (input, output, callback) {
    const previewArgs = this.config.preview.
      trim().
      split(/\s+/).
      map((arg) => {
        return arg.replace('$input', input).
          replace('$output', output).
          replace('$interval', this.config.previewInterval);
      });

    this.log(` * generating preview video for ${ input }`);

    return execFile(this.config.ffmpeg, previewArgs, (error) => {
      if (error) {
        return callback(error);
      }

      this.log(` * generated preview video ${ output }`);

      return callback(null, output);
    });
  }

  hasSound (file, callback) {
    if (!this.config.checkSound) {
      return setImmediate(() => {
        return callback(null, null);
      });
    }

    this.log(` * checking for sound in ${ file }`);
    const soundArgs = this.config.sound.
      trim().
      split(/\s+/).
      map((arg) => {
        return arg.replace('$file', file);
      });

    return execFile(this.config.ffmpeg, soundArgs, (error, stdout, soundInfo) => {
      if (error) {
        return callback(error);
      }

      const sound = !soundInfo.includes('mean_volume: -91');

      this.log(` * sound in ${ file }: ${ sound }`);

      return callback(null, sound);
    });
  }

  converter ({
    file, slot
  }, callback) {
    const [ , name, extension ] = file.match(/([^/]+)\.([^.]+)$/);
    const shortName = name.length > 25 ? `${ name.substring(0, 22) }…` : name;

    const prettyName = style(`${ name }.${ extension }`, 'style: bold');
    const prettyShortName = style(`${ shortName }.${ extension }`, 'style: bold');

    slot.spinner = new Spinner({
      prepend: `  Fingerprinting ${ prettyName } `,
      spinner: 'dots4',
      style: 'fg: DodgerBlue1',
      x: 0,
      y: slot.y
    });
    slot.spinner.start();

    this.log(` * hashing ${ file }`);
    return execFile(this.config.shasum, [ file ], (error, sha) => {
      slot.spinner.stop();

      if (error) {
        return callback(error);
      }

      const [ hash ] = sha.trim().split(/\s+/);

      this.log(` * hashed ${ file }: ${ hash }`);

      const occurrence = {
        hash,
        file,
        path: file.replace(/\/([^/]+)$/, '/'),
        name,
        extension
      };

      return this.lookup(hash, (error, item) => {
        if (error) {
          return callback(error);
        }

        if (item) {
          this.log(` - match for ${ hash } found`);

          this.log(` * updating metadata for ${ name }/${ hash }`);

          let found = false;
          for (const one of item.metadata.occurrences) {
            if (one.file === occurrence.file) {
              found = true;
              break;
            }
          }
          if (found) {
            this.log(` - existing occurrence found for ${ occurrence.file }`);
          } else {
            item.metadata.occurrences.push(occurrence);
          }

          this.log(` - updating tags for ${ name }`);
          this.tagger(item, this.config);
          item.metadata.updated = Date.now();

          return this.media.updateOne({ id: item.id }, { $set: item }, (error) => {
            if (error) {
              return callback(error);
            }

            this.log(` * metadata updated for ${ name }`);

            return this.delete(file, (error) => {
              if (error) {
                return callback(error);
              }
              this.progress.total--;
              this.tokens.processed++;
              return callback(null, item);
            });
          });
        }

        this.log(` - no match for ${ hash }`);
        return this.examine(file, (error, stat, details) => {
          if (error) {
            return callback(error);
          }

          occurrence.size = stat.size;
          occurrence.timestamp = new Date(stat.mtime).getTime();

          const id = uuid();

          const directory = join(this.config.save, id.substring(0, 2));
          const filename = id.substring(2).replace(/-/g, '');

          const output = join(directory, `${ filename }.${ this.config.format }`);
          const preview = join(directory, `${ filename }.${ this.config.previewFormat }`);

          return fs.mkdir(directory, { recursive: true }, (error) => {
            if (error) {
              return callback(error);
            }

            const convertCommand = hasSubtitles(details) ? this.config.convertSubtitles :
              this.config.convert;

            const convertArgs = convertCommand.
              trim().
              split(/\s+/).
              map((arg) => {
                return arg.replace('$input', file).
                  replace('$output', output).
                  replace('$format', this.config.format);
              });

            this.log(` * converting ${ name }.${ extension } in slot ${ slot.index }`);

            slot.progress = new ProgressBar({
              format: `  Converting ${ prettyShortName } $left$progress$right ` +
                '$percent ($eta remaining)',
              total: Infinity,
              width: 40,
              y: slot.y,
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

              if (slot.progress.total === Infinity && durationRegExp.test(log)) {
                const [ , duration ] = log.match(durationRegExp);
                slot.progress.total = timeToValue(duration);
              } else if (timeRegExp.test(data)) {
                const [ , time ] = data.match(timeRegExp);
                slot.progress.value = timeToValue(time);
              }
            });

            convert.on('exit', (code) => {
              slot.progress.done();

              if (code !== 0) {
                this.log(` ! failed to convert ${ name }.${ extension }`);
                return callback(new Error(`Failed to convert ${ name }.${ extension }`));
              }

              this.log(` * converted ${ name }.${ extension }!`);

              slot.spinner = new Spinner({
                prepend: `  Generating preview and metadata for ${ prettyName } `,
                spinner: 'dots4',
                style: 'fg: DodgerBlue1',
                x: 0,
                y: slot.y
              });
              slot.spinner.start();

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

                return this.examine(output, (error, converted, info) => {
                  if (error) {
                    return callback(error);
                  }

                  this.log(` * obtained info for ${ output }`);

                  return this.hasSound(output, (error, sound) => {
                    if (error) {
                      return callback(error);
                    }

                    return this.preview(output, preview, (error) => {
                      if (error) {
                        return callback(error);
                      }

                      const model = this.model({
                        id,
                        occurrence,
                        output,
                        converted,
                        thumbnail,
                        preview,
                        info,
                        sound
                      });

                      this.log(` - inserting ${ name } [${ id }] into db`);

                      return this.media.insertOne(model, (error) => {
                        if (error) {
                          return callback(error);
                        }

                        this.log(` - inserted ${ name } [${ id }] into db`);
                        return this.delete(file, (error) => {
                          if (error) {
                            return callback(error);
                          }

                          slot.spinner.stop();
                          this.progress.value++;
                          this.tokens.processed++;
                          return callback(null, model);
                        });
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
