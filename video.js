'use strict';

const fs = require('fs/promises');
const { join } = require('path');
const subtitle = require('subtitle');
const style = require('barrkeep/style');
const { ProgressBar, Spinner } = require('barrkeep/progress');
const {
  execFile, safeExecFile, safeRmdir, safeStat, safeUnlink, spawn,
} = require('./utils');

//////////

const durationRegExp = /Duration:\s(\d+:\d+:\d+\.\d+)/;
const timeRegExp = /time=(\d+:\d+:\d+\.\d+)/;
const maxVolumeRegExp = /max_volume: ([-.\d]+) dB/;
const meanVolumeRegExp = /mean_volume: ([-.\d]+) dB/;

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

    if (typeof this.indexer.config.video.delete === 'function') {
      this.shouldDelete = this.indexer.config.video.delete;
    } else {
      this.shouldDelete = () => this.indexer.config.video.delete;
    }
  }

  async tag (model) {
    if (!this.tagger) {
      return model;
    }

    this.indexer.log.info(`tagging ${ model.name }`);

    await this.tagger(model, this.indexer.config);
    model.metadata.updated = Date.now();
    return model;
  }

  model ({
    id, hash, occurrence, occurrences, output, converted,
    thumbnail, preview, subtitles, info, sound,
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

    const sources = new Set([ id, hash ]);
    if (occurrence) {
      sources.add(occurrence.id);
    }
    if (Array.isArray(occurrences)) {
      for (const item of occurrences) {
        sources.add(item.id);
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
      sources: Array.from(sources),
      relative: output.replace(this.indexer.config.video.save, '').replace(/^\//, ''),
      thumbnail: thumbnail.replace(this.indexer.config.video.save, '').replace(/^\//, ''),
      preview: preview.replace(this.indexer.config.video.save, '').replace(/^\//, ''),
      subtitles: subtitles ? subtitles.replace(this.indexer.config.video.save, '').replace(/^\//, '') : false,
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
      deleted: false,
    };

    return model;
  }

  async lookup (id) {
    return this.indexer.database.media.findOne({
      $or: [
        {
          sources: id,
          deleted: { $ne: true },
        }, { sources: id }, { id }, { hash: id },
      ],
    });
  }

  async skipFile (file) {
    if (this.indexer.config.video.canSkip && !this.shouldDelete(file)) {
      const item = await this.indexer.database.media.findOne({ 'metadata.occurrences.file': file });
      return Boolean(item);
    }
    return false;
  }

  async duplicate (model, occurrence) {
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

    const sources = new Set([ model.id, model.hash ]);
    sources.add(occurrence.id);
    if (Array.isArray(model.metadata.occurrences)) {
      for (const item of model.metadata.occurrences) {
        sources.add(item.id);
      }
    }
    model.sources = Array.from(sources);

    this.indexer.log.info(`updating tags for ${ occurrence.id }`);
    const update = await this.tag(model);

    await this.indexer.database.media.replaceOne({ id: model.id }, update);

    this.indexer.log.info(`metadata updated for ${ model.id }`);

    await this.delete(occurrence.file);

    return update;
  }

  async examine (file) {
    this.indexer.log.info(`examining ${ file }`);
    const stat = await fs.stat(file);

    this.indexer.log.info(`probing detailed information for ${ file }`);

    const probeArgs = this.indexer.config.video.probe.
      trim().
      split(/\s+/).
      map((arg) => arg.replace('$file', file));

    const { stdout } = await execFile(this.indexer.config.video.ffprobe, probeArgs);

    const data = JSON.parse(stdout);
    return [ stat, data ];
  }

  async delete (file) {
    if (this.shouldDelete(file)) {
      this.indexer.log.info(`deleting ${ file }`);
      await fs.unlink(file);
      this.indexer.log.info(`deleted ${ file }`);
    }
  }

  async preview (input, output, duration) {
    const interval = Math.ceil(duration / this.indexer.config.video.previewDuration);

    const previewArgs = this.indexer.config.video.preview.
      trim().
      split(/\s+/).
      map((arg) => arg.replace('$input', input).
        replace('$output', output).
        replace('$framerate', this.indexer.config.video.framerate).
        replace('$interval', interval));

    this.indexer.log.info(`generating preview video for ${ input }`);

    await execFile(this.indexer.config.video.ffmpeg, previewArgs);
    this.indexer.log.info(`generated preview video ${ output }`);

    return output;
  }

  async hasSound (file) {
    const sound = {
      silent: true,
      mean: -91,
      max: -91,
    };

    if (!this.indexer.config.video.checkSound) {
      return sound;
    }

    this.indexer.log.info(`checking for sound in ${ file }`);
    const soundArgs = this.indexer.config.video.sound.
      trim().
      split(/\s+/).
      map((arg) => arg.replace('$file', file));

    const { stderr } = await execFile(this.indexer.config.video.ffmpeg, soundArgs);

    if (maxVolumeRegExp.test(stderr)) {
      const [ , level ] = stderr.match(maxVolumeRegExp);
      sound.max = Number(level);
    }

    if (meanVolumeRegExp.test(stderr)) {
      const [ , level ] = stderr.match(meanVolumeRegExp);
      sound.mean = Number(level);
    }

    if (sound.mean > this.indexer.config.video.soundThreshold) {
      sound.silent = false;
    }

    this.indexer.log.info(`sound in ${ file }: ${ sound }`);

    return sound;
  }

  async extractSubtitles ({
    file, details, output,
  }) {
    if (hasSubtitles(details)) {
      let subtitleArgs = this.indexer.config.video.subtitle.
        trim().
        split(/\s+/).
        map((arg) => arg.replace('$input', file).
          replace('$output', output).
          replace('$language', this.indexer.config.video.subtitleLanguage));

      const { error } = await safeExecFile(this.indexer.config.video.ffmpeg, subtitleArgs);
      if (!error) {
        this.indexer.log.info(`extracted subtitles to ${ output }`);
      } else {
        subtitleArgs = this.indexer.config.video.subtitleFallback.
          trim().
          split(/\s+/).
          map((arg) => arg.replace('$input', file).
            replace('$output', output));

        const { error } = await execFile(this.indexer.config.video.ffmpeg, subtitleArgs);

        if (error) {
          this.indexer.log.info(`failed to extract subtitles ${ error } ${ file } ${ output }`);
          return false;
        }

        this.indexer.log.info(`extracted subtitles using fallback to ${ output }`);
      }
      const text = await this.extractSubtitlesText(output);
      return text;
    }

    const existing = file.replace(/([^./]+)$/, this.indexer.config.video.subtitleFormat);

    this.indexer.log.info(`checking for existing subtitles in ${ existing }`);
    const stats = await safeStat(existing);
    if (!stats || !stats.isFile()) {
      return false;
    }

    this.indexer.log.info(`found existing subtitles in ${ existing }`);
    await fs.copyFile(existing, output);

    this.indexer.log.info(`existing subtitles copied to ${ output }`);
    const text = await this.extractSubtitlesText(output);
    return text;
  }

  async extractSubtitlesText (file) {
    return new Promise((resolve) => {
      const data = [];
      return fs.createReadStream(file).
        pipe(subtitle.parse()).
        on('data', node => {
          if (node.data && node.data.text) {
            data.push(node.data.text);
          }
        }).
        on('error', (error) => {
          this.indexer.log.error('error parsing subtitles');
          this.indexer.log.error(error);

          return resolve(false);
        }).
        on('finish', () => {
          const text = data.join('\n');
          this.indexer.log.info(`parsed subtitles into text (${ text.length })`);
          return resolve(text);
        });
    });
  }

  async indexSubtitles (model, text) {
    if (!model.subtitles || !text) {
      return;
    }

    this.indexer.log.info(`indexing subtitles for ${ model.id }`);

    await this.indexer.elastic.client.index({
      index: 'subtitles',
      body: {
        id: model.id,
        name: model.name,
        text,
      },
    });

    this.indexer.log.info(`subtitles indexed for ${ model.id }`);

    await this.indexer.elastic.client.indices.refresh();

    this.indexer.log.info('elasticsearch indices refreshed');
  }

  async converter ({ file, slot }) {
    const skip = await this.skipFile(file);

    if (skip) {
      this.indexer.log.info(`skipping file due to existing entry ${ file }`);
      this.indexer.stats.skipped++;
      return;
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

      let shortName = `${ name }.${ extension }`.replace(/[^\x00-\x7F]/g, '');
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
    const { stdout: sha } = await execFile(this.indexer.config.video.shasum, [ file ]);
    slot.spinner.stop();

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
        return;
      }
    }

    slot.id = id;
    slot.occurrences = [ occurrence ];

    const item = await this.lookup(id);

    if (item) {
      this.indexer.log.info(`match for ${ id } found`);
      await this.duplicate(item, occurrence);
      return;
    }

    this.indexer.log.info(`no match for ${ id }`);
    const [ stat, details ] = await this.examine(file);
    if (!stat || !details) {
      return;
    }

    occurrence.size = stat.size;
    occurrence.timestamp = new Date(stat.mtime).getTime();

    const directory = join(this.indexer.config.video.save, id.substring(0, 2));
    const filename = id.substring(2);

    const output = join(directory, `${ filename }.${ this.indexer.config.video.format }`);
    const preview = join(directory, `${ filename }p.${ this.indexer.config.video.format }`);

    await fs.mkdir(directory, { recursive: true });

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

    const subtitles = await this.extractSubtitles({
      file,
      details,
      output: join(directory, `${ filename }.${ this.indexer.config.video.subtitleFormat }`),
    });

    const convertArgs = this.indexer.config.video.convert.
      trim().
      split(/\s+/).
      map((arg) => arg.replace('$input', file).
        replace('$output', output).
        replace('$format', this.indexer.config.video.format).
        replace('$framerate', this.indexer.config.video.framerate));

    this.indexer.log.info(`converting ${ name }.${ extension } in slot ${ slot.index }`);

    let log = '';
    const code = await spawn(this.indexer.config.video.ffmpeg, convertArgs,
      { stdio: [ 'ignore', 'ignore', 'pipe' ] }, {
        stderr: (data) => {
          data = data.toString();
          log += data;

          if (slot.progress.total === Infinity && durationRegExp.test(log)) {
            const [ , duration ] = log.match(durationRegExp);
            slot.progress.total = timeToValue(duration);
          } else if (timeRegExp.test(data)) {
            const [ , time ] = data.match(timeRegExp);
            slot.progress.value = timeToValue(time);
          }
        },
      });

    slot.progress.done();

    if (code !== 0) {
      this.indexer.log.error(`failed to convert ${ name }.${ extension } - exited ${ code }`);
      this.indexer.log.error(log);
      return;
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
    const { stdout: outputSha } = await execFile(this.indexer.config.video.shasum, [ output ]);
    const [ hash ] = outputSha.trim().split(/\s+/);

    this.indexer.log.info(`${ output } has id ${ hash }`);

    const duplicate = await this.lookup(hash);
    if (duplicate) {
      this.indexer.log.info(`match for converted ${ hash } found`);
      await this.duplicate(duplicate, occurrence);
      await safeUnlink(output);
      slot.spinner.stop();
      await safeRmdir(directory);
    }
    this.indexer.log.info(`no duplicates of ${ output } (${ hash }) found`);

    const thumbnail = output.replace(this.indexer.config.video.format, this.indexer.config.video.thumbnailFormat);
    let time = Math.floor(Math.min(this.indexer.config.video.thumbnailTime, Number(details.format.duration) - 1));

    if (Number.isNaN(time) || time === Infinity || time < 0) {
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

    await execFile(this.indexer.config.video.ffmpeg, thumbnailArgs);
    this.indexer.log.info(`generated thumbnail ${ thumbnail } at ${ timeString }s`);

    const [ converted, info ] = await this.examine(output);
    this.indexer.log.info(`obtained info for ${ output }`);

    const sound = await this.hasSound(output);

    await this.preview(output, preview, info.format.duration);

    const model = this.model({
      id,
      hash,
      occurrence,
      occurrences: slot.occurrences,
      output,
      converted,
      thumbnail,
      preview,
      subtitles: Boolean(subtitles),
      info,
      sound,
    });

    await this.tag(model);

    this.indexer.log.info(`inserting ${ name } (${ id }) into db`);

    await this.indexSubtitles(model, subtitles);

    await this.indexer.database.media.insertOne(model);
    this.indexer.log.info(`inserted ${ name } (${ id }) into db`);

    await this.delete(file);

    slot.spinner.stop();

    this.stats.converted++;
  }
}

module.exports = Video;
