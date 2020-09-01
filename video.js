'use strict';

const fs = require('fs');
const { join } = require('path');
const style = require('barrkeep/style');
const { execFile, spawn } = require('child_process');
const { ProgressBar, Spinner } = require('barrkeep/progress');

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

class Video {
  constructor (indexer) {
    this.indexer = indexer;
    this.config = indexer.config;

    if (typeof this.indexer.config.video.tagger === 'function') {
      this.tagger = this.indexer.config.video.tagger;
    }
  }

  tag (model, callback) {
    if (!this.tagger) {
      return setImmediate(callback, null, model);
    }
    this.indexer.log.info(`tagging ${ model.name }`);

    if (this.tagger.length < 3) { // i.e. no callback
      const result = this.tagger(model, this.indexer.config);

      if (result instanceof Promise) {
        return result.
          then(() => {
            model.metadata.updated = Date.now();
            return callback(null, model);
          }).
          catch((error) => callback(error));
      }

      model.metadata.updated = Date.now();
      return setImmediate(callback, null, model);
    }
    return this.tagger(model, this.indexer.config, (error) => {
      if (error) {
        return callback(error);
      }

      model.metadata.updated = Date.now();

      return callback(null, model);
    });
  }

  model ({
    id, hash, occurrence, occurrences, output, converted, thumbnail, preview, info, sound,
  }) {
    let duration;
    let aspect;
    let width;
    let height;

    if (info.format && info.format.duration) {
      duration = Number(info.format.duration);
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
      version: this.indexer.config.version,
      name: occurrence.name,
      description: '',
      hash,
      relative: output.replace(this.indexer.config.video.save, '').replace(/^\//, ''),
      thumbnail: thumbnail.replace(this.indexer.config.video.save, '').replace(/^\//, ''),
      preview: preview.replace(this.indexer.config.video.save, '').replace(/^\//, ''),
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
        occurrences: occurrences || [ occurrence ],
        series: false,
        views: 0,
        stars: 0,
        favorited: false,
        reviewed: false,
        private: false,
        tags: [ ],
      },
    };

    return model;
  }

  lookup (query, callback) {
    return this.indexer.media.findOne(query, callback);
  }

  skipFile (file, callback) {
    if (this.indexer.config.video.canSkip && !this.indexer.config.video.delete) {
      return this.indexer.media.findOne({ 'metadata.occurrences.file': file }, (error, item) => {
        if (error) {
          return callback(error);
        }

        return callback(null, Boolean(item));
      });
    }
    return setImmediate(callback, null, false);
  }

  duplicate (model, occurrence, callback) {
    this.indexer.log.info(`updating metadata for ${ model.id }`);
    this.indexer.stats.duplicates++;

    let found = false;
    for (const item of model.metadata.occurrences) {
      if (item.file === occurrence.file) {
        found = true;
        break;
      }
    }
    if (found) {
      this.indexer.log.info(`existing occurrence found for ${ occurrence.file }`);
    } else {
      model.metadata.occurrences.push(occurrence);
    }

    this.indexer.log.info(`updating tags for ${ occurrence.id }`);
    return this.tag(model, (error, update) => {
      if (error) {
        return callback(error);
      }

      return this.indexer.media.replaceOne({ id: model.id }, update, (error) => {
        if (error) {
          return callback(error);
        }

        this.indexer.log.info(`metadata updated for ${ model.id }`);

        return this.delete(occurrence.file, (error) => {
          if (error) {
            return callback(error);
          }
          this.indexer.progress.total--;
          this.indexer.tokens.processed++;
          return callback(null, update);
        });
      });
    });
  }

  examine (file, callback) {
    this.indexer.log.info(`examining ${ file }`);
    return fs.stat(file, (error, stat) => {
      if (error || !stat) {
        return callback(error || new Error(`No file details for ${ file }`));
      }

      this.indexer.log.info(`probing detailed information for ${ file }`);

      const probeArgs = this.indexer.config.video.probe.
        trim().
        split(/\s+/).
        map((arg) => arg.replace('$file', file));

      return execFile(this.indexer.config.video.ffprobe, probeArgs, (error, info, stderr) => {
        if (error) {
          return callback(stderr || error);
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
    if (this.indexer.config.video.delete) {
      this.indexer.log.info(`deleting ${ file }`);

      return fs.unlink(file, (error) => {
        if (error) {
          return callback(error);
        }
        this.indexer.log.info(`deleted ${ file }`);

        return callback(null);
      });
    }
    return setImmediate(callback);
  }

  preview (input, output, duration, callback) {
    const interval = Math.ceil(duration / this.indexer.config.video.previewDuration);

    const previewArgs = this.indexer.config.video.preview.
      trim().
      split(/\s+/).
      map((arg) => arg.replace('$input', input).
        replace('$output', output).
        replace('$framerate', this.indexer.config.video.framerate).
        replace('$interval', interval));

    this.indexer.log.info(`generating preview video for ${ input }`);

    return execFile(this.indexer.config.video.ffmpeg, previewArgs, (error, stdout, stderr) => {
      if (error) {
        return callback(stderr || error);
      }

      this.indexer.log.info(`generated preview video ${ output }`);

      return callback(null, output);
    });
  }

  hasSound (file, callback) {
    if (!this.indexer.config.video.checkSound) {
      return setImmediate(() => callback(null, null));
    }

    this.indexer.log.info(`checking for sound in ${ file }`);
    const soundArgs = this.indexer.config.video.sound.
      trim().
      split(/\s+/).
      map((arg) => arg.replace('$file', file).replace('$duration', this.indexer.config.video.soundDuration));

    return execFile(this.indexer.config.video.ffmpeg, soundArgs, (error, stdout, soundInfo) => {
      if (error) {
        return callback(soundInfo);
      }

      const sound = !soundInfo.includes('mean_volume: -91');

      this.indexer.log.info(`sound in ${ file }: ${ sound }`);

      return callback(null, sound);
    });
  }

  converter ({ file, slot }, callback) {
    return this.skipFile(file, (error, skip) => {
      if (error) {
        return callback(error);
      }

      if (skip) {
        this.indexer.log.info(`skipping file due to existing entry ${ file }`);
        this.indexer.stats.skipped++;
        this.indexer.progress.total--;
        this.indexer.tokens.processed++;
        return callback(null);
      }

      const [ , name, extension ] = file.match(/([^/]+)\.([^.]+)$/);

      const nameWidth = 25;
      let scrollStart = 0;
      let slow = 0;

      let scrollFormat;

      const scrollName = (format) => {
        if (format) {
          scrollFormat = format;
          scrollStart = 0;
        }

        let shortName = `${ name }.${ extension }`;
        if (shortName.length > 25) {
          shortName = shortName.substring(scrollStart, scrollStart + nameWidth);

          if (scrollStart < 0) {
            shortName = shortName.padStart(25, ' ');
          } else {
            shortName = shortName.padEnd(25, ' ');
          }
        }
        const prettyShortName = style(shortName, 'style: bold');
        const result = scrollFormat.replace('$name', prettyShortName);

        if (/^\s+$/.test(shortName)) {
          scrollStart = nameWidth * -1 + 1;
        } else {
          scrollStart++;
        }

        return result;
      };

      slot.spinner = new Spinner({
        prepend: scrollName('  Fingerprinting $name '),
        spinner: 'dots4',
        style: 'fg: DodgerBlue1',
        x: 0,
        y: slot.y,
      });
      slot.spinner.start();
      slot.spinner.onTick = () => {
        if (slow % 2 === 0) {
          slot.spinner.prepend = scrollName();
        }
        slow++;
      };

      this.indexer.log.info(`hashing ${ file }`);
      return execFile(this.indexer.config.video.shasum, [ file ], (error, sha, stderr) => {
        slot.spinner.stop();

        if (error) {
          return callback(stderr || error);
        }

        const [ id ] = sha.trim().split(/\s+/);

        this.indexer.log.info(`hashed ${ file }: ${ id }`);

        const occurrence = {
          id,
          file,
          path: file.replace(/\/([^/]+)$/, '/'),
          name,
          extension,
        };

        for (let i = 0; i < this.indexer.slots.length; i++) {
          if (this.indexer.slots[i] && this.indexer.slots[i].index !== slot.index && this.indexer.slots[i].id === id) {
            this.indexer.log.info(`slot ${ i } is already processing ${ id }`);
            this.indexer.slots[i].occurrences.push(occurrence);

            this.indexer.progress.total--;
            this.indexer.tokens.processed++;
            return callback(null);
          }
        }

        slot.id = id;
        slot.occurrences = [ occurrence ];

        return this.lookup({ id }, (error, item) => {
          if (error) {
            return callback(error);
          }

          if (item) {
            this.indexer.log.info(`match for ${ id } found`);
            return this.duplicate(item, occurrence, callback);
          }

          this.indexer.log.info(`no match for ${ id }`);
          return this.examine(file, (error, stat, details) => {
            if (error || !stat || !details) {
              return callback(error || new Error(`Examine failed for ${ file }`));
            }

            occurrence.size = stat.size;
            occurrence.timestamp = new Date(stat.mtime).getTime();

            const directory = join(this.indexer.config.video.save, id.substring(0, 2));
            const filename = id.substring(2);

            const output = join(directory, `${ filename }.${ this.indexer.config.video.format }`);
            const preview = join(directory, `${ filename }p.${ this.indexer.config.video.format }`);

            return fs.mkdir(directory, { recursive: true }, (error) => {
              if (error) {
                return callback(error);
              }

              const convertCommand = hasSubtitles(details) ? this.indexer.config.video.convertSubtitles :
                this.indexer.config.video.convert;

              const subtitles = file.replace(/'/g, '\\$1');

              const convertArgs = convertCommand.
                trim().
                split(/\s+/).
                map((arg) => arg.replace('$input', file).
                  replace('$subtitles', subtitles).
                  replace('$output', output).
                  replace('$format', this.indexer.config.video.format).
                  replace('$framerate', this.indexer.config.video.framerate));

              this.indexer.log.info(`converting ${ name }.${ extension } in slot ${ slot.index }`);

              slot.progress = new ProgressBar({
                format: scrollName('  Converting $name $left$progress$right $percent ($eta remaining)'),
                total: Infinity,
                width: this.indexer.progressMax,
                y: slot.y,
                complete: style('━', 'fg: Green4'),
                head: style('▶', 'fg: Green4'),
                clear: true,
                tokens: this.indexer.tokens,
              });

              slot.progress.onTick = () => {
                if (slow % 2 === 0) {
                  slot.progress.format = scrollName();
                }
                slow++;
              };

              const convert = spawn(this.indexer.config.video.ffmpeg, convertArgs,
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
                  this.indexer.log.error(`failed to convert ${ name }.${ extension } - exited ${ code }`);
                  this.indexer.log.error(log);
                  return callback(new Error(`Failed to convert ${ name }.${ extension } - exited ${ code }`));
                }

                this.indexer.log.info(`converted ${ name }.${ extension }!`);

                slot.spinner = new Spinner({
                  prepend: scrollName('  Generating preview and metadata for $name '),
                  spinner: 'dots4',
                  style: 'fg: DodgerBlue1',
                  x: 0,
                  y: slot.y,
                });
                slot.spinner.start();
                slot.spinner.onTick = () => {
                  if (slow % 2 === 0) {
                    slot.spinner.prepend = scrollName();
                  }
                  slow++;
                };

                this.indexer.log.info(`checking for duplicate of ${ output }`);
                return execFile(this.indexer.config.video.shasum, [ output ], (error, outputSha) => {
                  if (error) {
                    return callback(error);
                  }

                  const [ hash ] = outputSha.trim().split(/\s+/);

                  this.indexer.log.info(`${ output } has id ${ hash }`);

                  return this.lookup({ hash }, (error, duplicate) => {
                    if (error) {
                      slot.spinner.stop();
                      return callback(error);
                    }

                    if (duplicate) {
                      this.indexer.log.info(`match for converted ${ hash } found`);
                      return this.duplicate(duplicate, occurrence, (error, updated) => {
                        if (error) {
                          slot.spinner.stop();
                          return callback(error);
                        }
                        return fs.unlink(output, (error) => {
                          slot.spinner.stop();
                          if (error) {
                            return callback(error);
                          }
                          // attempt to delete directory, ignore error if it fails
                          return fs.rmdir(directory, () => callback(null, updated));
                        });
                      });
                    }
                    this.indexer.log.info(`no duplicates of ${ output } (${ hash }) found`);

                    const thumbnail = output.replace(this.indexer.config.video.format, this.indexer.config.video.thumbnailFormat);
                    let time = Math.floor(Math.min(this.indexer.config.video.thumbnailTime, Number(details.format.duration) - 1));
                    if (Number.isNaN(time) || time === Infinity) {
                      time = 0;
                    }

                    const timeString = time.toFixed(3).padStart(6, '0');

                    const thumbnailArgs = this.indexer.config.video.thumbnail.
                      trim().
                      split(/\s+/).
                      map((arg) => arg.replace('$output', output).
                        replace('$thumbnail', thumbnail).
                        replace('$time', timeString));

                    this.indexer.log.info(`generating thumbnail ${ thumbnail }`);

                    return execFile(this.indexer.config.video.ffmpeg, thumbnailArgs, (error, stdout, thumbnailError) => {
                      if (error) {
                        return callback(thumbnailError || error);
                      }

                      this.indexer.log.info(`generated thumbnail ${ thumbnail } at ${ timeString }s`);

                      return this.examine(output, (error, converted, info) => {
                        if (error) {
                          return callback(error);
                        }

                        this.indexer.log.info(`obtained info for ${ output }`);

                        return this.hasSound(output, (error, sound) => {
                          if (error) {
                            return callback(error);
                          }

                          return this.preview(output, preview, info.format.duration, (error) => {
                            if (error) {
                              return callback(error);
                            }

                            const model = this.model({
                              id,
                              hash,
                              occurrence,
                              occurrences: slot.occurrences,
                              output,
                              converted,
                              thumbnail,
                              preview,
                              info,
                              sound,
                            });

                            return this.tag(model, (error) => {
                              if (error) {
                                return callback(error);
                              }

                              this.indexer.log.info(`inserting ${ name } (${ id }) into db`);

                              return this.indexer.media.insertOne(model, (error) => {
                                if (error) {
                                  return callback(error);
                                }

                                this.indexer.log.info(`inserted ${ name } (${ id }) into db`);
                                return this.delete(file, (error) => {
                                  if (error) {
                                    return callback(error);
                                  }

                                  this.indexer.stats.converted++;

                                  slot.spinner.stop();
                                  this.indexer.progress.value++;
                                  this.indexer.tokens.processed++;
                                  return callback(null, model);
                                });
                              });
                            });
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
    });
  }
}

module.exports = Video;