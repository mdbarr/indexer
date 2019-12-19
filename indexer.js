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
const { ProgressBar } = require('barrkeep/progress');
const {
  execFile, spawn
} = require('child_process');

const version = require('./package.json').version;

const defaults = {
  name: `Indexer v${ version }`,
  scan: process.cwd(),
  pattern: /\.(asf|avi|flv|mkv|mpg|mp4|m4v|wmv|3gp)$/,
  db: 'mongodb://localhost:27017/indexer',
  concurrency: 1,
  shasum: '/usr/bin/sha1sum',
  ffmpeg: '/usr/bin/ffmpeg',
  convert: '-i $input -f $format -vcodec libx264 -preset fast' +
    ' -profile:v main -acodec aac $output -hide_banner -y',
  format: 'mp4',
  thumbnailFormat: 'png',
  thumbnail: '-i $output -ss 00:00:03.000 -vframes 1 $thumbnail -y',
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

    this.queue = async.queue(this.converter.bind(this), this.config.concurrency);

    this.queue.error((error, task) => {
      this.log(` x error in processing ${ task }`);
      this.log(error);

      if (this.progress) {
        this.progress.total--;
      }
    });

    process.on('SIGINT', () => {
      console.log('\x1b[?25h\nCanceled.');
      process.exit(0);
    });
  }

  model ({
    id, original, output, converted, thumbnail, info
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
    return fs.stat(file, (error, stat) => {
      if (error) {
        return callback(error);
      }

      return execFile(this.config.shasum, [ file ], (error, sha) => {
        if (error) {
          return callback(error);
        }

        const [ , name, extension ] = file.match(/([^/]+)\.([^.]+)$/);
        const [ hash ] = sha.trim().split(/\s+/);

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
                  return callback(null, item);
                });
              }
              this.progress.total--;
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

            this.log(` * converting ${ name }.${ extension } ...`);

            const convert = spawn(this.config.ffmpeg, convertArgs, { stdio: 'ignore' });

            convert.on('exit', (code) => {
              if (code !== 0) {
                this.log(` ! failed to convert ${ name }.${ extension }`);
                return callback(new Error(`Failed to convert ${ name }.${ extension }`));
              }

              this.log(` * converted ${ name }.${ extension }!`);

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

                    const model = this.model({
                      id,
                      original,
                      output,
                      converted,
                      thumbnail,
                      info
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

                          this.progress.value++;
                          return callback(null, model);
                        });
                      }

                      this.progress.value++;
                      return callback(null, model);
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
      format: '  Processing $remaining files $left$progress$right ' +
        '$percent ($eta remaining) $spinner',
      total: 1,
      width: 40,
      complete: style('━', 'fg: SteelBlue'),
      head: style('▶', 'fg: SteelBlue'),
      spinner: 'dots',
      clear: true,
      environment: {
        left: style('[', 'fg: grey'),
        right: style(']', 'fg: grey')
      }
    });

    this.scanner = new Scanner(this.config);

    this.scanner.on('file', (event) => {
      if (event.data.index !== 1) {
        this.progress.total++;
      }
      this.queue.push(event.data.path);
    });

    this.scanner.add(this.config.scan);

    return this.queue.drain(() => {
      console.log('\x1b[?25hDone.');
      return callback();
    });
  }

  start (callback) {
    callback = utils.callback(callback);

    console.log(`${ this.config.name } starting up...`);

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
