'use strict';

const subtitle = require('subtitle');
const { join } = require('node:path');
const fs = require('node:fs/promises');
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
    this.config = indexer.config.video;

    this.common = require('./common')(indexer, this.config);
  }

  //////////

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
      relative: output.replace(this.config.save, '').replace(/^\//, ''),
      thumbnail: thumbnail.replace(this.config.save, '').replace(/^\//, ''),
      preview: preview.replace(this.config.save, '').replace(/^\//, ''),
      subtitles: subtitles ? subtitles.replace(this.config.save, '').replace(/^\//, '') : false,
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

  //////////

  async examine (file) {
    this.indexer.log.info(`examining ${ file }`);
    const stat = await fs.stat(file);

    this.indexer.log.info(`probing detailed information for ${ file }`);

    const probeArgs = this.config.probe.
      trim().
      split(/\s+/).
      map((arg) => arg.replace('$file', file));

    const { stdout } = await execFile(this.config.ffprobe, probeArgs);

    const data = JSON.parse(stdout);
    return [ stat, data ];
  }

  async delete (file) {
    if (this.common.shouldDelete(file)) {
      this.indexer.log.info(`deleting ${ file }`);
      await fs.unlink(file);
      this.indexer.log.info(`deleted ${ file }`);
    }
  }

  async preview (input, output, duration) {
    const interval = Math.ceil(duration / this.config.previewDuration);

    const previewArgs = this.config.preview.
      trim().
      split(/\s+/).
      map((arg) => arg.replace('$input', input).
        replace('$output', output).
        replace('$framerate', this.config.framerate).
        replace('$interval', interval));

    this.indexer.log.info(`generating preview video for ${ input }`);

    await execFile(this.config.ffmpeg, previewArgs);
    this.indexer.log.info(`generated preview video ${ output }`);

    return output;
  }

  async hasSound (file) {
    const sound = {
      silent: true,
      mean: -91,
      max: -91,
    };

    if (!this.config.checkSound) {
      return sound;
    }

    this.indexer.log.info(`checking for sound in ${ file }`);
    const soundArgs = this.config.sound.
      trim().
      split(/\s+/).
      map((arg) => arg.replace('$file', file));

    const { stderr } = await execFile(this.config.ffmpeg, soundArgs);

    if (maxVolumeRegExp.test(stderr)) {
      const [ , level ] = stderr.match(maxVolumeRegExp);
      sound.max = Number(level);
    }

    if (meanVolumeRegExp.test(stderr)) {
      const [ , level ] = stderr.match(meanVolumeRegExp);
      sound.mean = Number(level);
    }

    if (sound.mean > this.config.soundThreshold) {
      sound.silent = false;
    }

    this.indexer.log.info(`sound in ${ file }: ${ sound }`);

    return sound;
  }

  async extractSubtitles ({ file, details, output }) {
    if (hasSubtitles(details)) {
      let subtitleArgs = this.config.subtitle.
        trim().
        split(/\s+/).
        map((arg) => arg.replace('$input', file).
          replace('$output', output).
          replace('$language', this.config.subtitleLanguage));

      const { error } = await safeExecFile(this.config.ffmpeg, subtitleArgs);
      if (!error) {
        this.indexer.log.info(`extracted subtitles to ${ output }`);
      } else {
        subtitleArgs = this.config.subtitleFallback.
          trim().
          split(/\s+/).
          map((arg) => arg.replace('$input', file).
            replace('$output', output));

        const { error } = await execFile(this.config.ffmpeg, subtitleArgs);

        if (error) {
          this.indexer.log.info(`failed to extract subtitles ${ error } ${ file } ${ output }`);
          return false;
        }

        this.indexer.log.info(`extracted subtitles using fallback to ${ output }`);
      }
      const text = await this.extractSubtitlesText(output);
      return text;
    }

    const existing = file.replace(/([^./]+)$/, this.config.subtitleFormat);

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
    const skip = await this.common.skipFile(file);

    if (skip) {
      this.indexer.log.info(`skipping file due to existing entry ${ file }`);
      this.indexer.stats.skipped++;
      return;
    }

    const [ , name, extension ] = file.match(/([^/]+)\.([^.]+)$/);

    const scrollName = this.common.nameScroller(name, extension);

    let slow = 0;

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
    const { stdout: sha } = await execFile(this.config.shasum, [ file ]);
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

    const item = await this.common.lookup(id);

    if (item) {
      this.indexer.log.info(`match for ${ id } found`);
      await this.common.duplicate(item, occurrence);
      return;
    }

    this.indexer.log.info(`no match for ${ id }`);
    const [ stat, details ] = await this.examine(file);
    if (!stat || !details) {
      return;
    }

    occurrence.size = stat.size;
    occurrence.timestamp = new Date(stat.mtime).getTime();

    const directory = join(this.config.save, id.substring(0, 2));
    const filename = id.substring(2);

    const output = join(directory, `${ filename }.${ this.config.format }`);
    const preview = join(directory, `${ filename }p.${ this.config.format }`);

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
      output: join(directory, `${ filename }.${ this.config.subtitleFormat }`),
    });

    const convertArgs = this.config.convert.
      trim().
      split(/\s+/).
      map((arg) => arg.replace('$input', file).
        replace('$output', output).
        replace('$format', this.config.format).
        replace('$framerate', this.config.framerate));

    this.indexer.log.info(`converting ${ name }.${ extension } in slot ${ slot.index }`);

    let log = '';
    const code = await spawn(this.config.ffmpeg, convertArgs,
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
    const { stdout: outputSha } = await execFile(this.config.shasum, [ output ]);
    const [ hash ] = outputSha.trim().split(/\s+/);

    this.indexer.log.info(`${ output } has id ${ hash }`);

    const duplicate = await this.common.lookup(hash);
    if (duplicate) {
      this.indexer.log.info(`match for converted ${ hash } found`);
      await this.common.duplicate(duplicate, occurrence);
      await safeUnlink(output);
      await safeRmdir(directory);
      return;
    }
    this.indexer.log.info(`no duplicates of ${ output } (${ hash }) found`);

    const thumbnail = output.replace(this.config.format, this.config.thumbnailFormat);
    let time = Math.floor(Math.min(this.config.thumbnailTime, Number(details.format.duration) - 1));

    if (Number.isNaN(time) || time === Infinity || time < 0) {
      time = 0;
    }

    const timeString = time.toFixed(3).padStart(6, '0');

    const thumbnailArgs = this.config.thumbnail.
      trim().
      split(/\s+/).
      map((arg) => arg.replace('$output', output).
        replace('$thumbnail', thumbnail).
        replace('$time', timeString));

    this.indexer.log.info(`generating thumbnail ${ thumbnail }`);

    await execFile(this.config.ffmpeg, thumbnailArgs);
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

    await this.common.tag(model);

    this.indexer.log.info(`inserting ${ name } (${ id }) into db`);

    await this.indexSubtitles(model, subtitles);

    await this.indexer.database.media.insertOne(model);
    this.indexer.log.info(`inserted ${ name } (${ id }) into db`);

    await this.delete(file);

    slot.spinner.stop();

    this.indexer.stats.converted++;
  }
}

module.exports = Video;
