'use strict';

const Common = require('./common');
const { join } = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('./utils');

class Image {
  constructor (indexer) {
    this.indexer = indexer;
    this.config = indexer.config.types.image;
    this.common = new Common(indexer, 'image', this.config);
  }

  //////////

  model ({
    id, hash, occurrence, occurrences, output, stat,
    thumbnail, preview, details,
  }) {
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
      object: this.config.type,
      version: this.indexer.config.version,
      name: occurrence.name,
      description: '',
      hash,
      sources: Array.from(sources),
      relative: output.replace(this.config.save, '').replace(/^\//, ''),
      thumbnail: thumbnail.replace(this.config.save, '').replace(/^\//, ''),
      preview: preview ? preview.replace(this.config.save, '').replace(/^\//, '') : false,
      size: stat.size,
      aspect: details.aspect,
      width: details.width,
      height: details.height,
      metadata: {
        created: new Date(stat.mtime).getTime(),
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

  identifyParser (data, object) {
    const stack = [ object ];

    let last = 0;
    for (const line of data) {
      let [ key, value ] = line.split(/: /);
      let depth = key.replace(/^(\s+).*$/, '$1').length / 2 - 1;
      if (depth > last) {
        depth = last + 1;
      } else if (depth < last) {
        depth = last;
        last--;
      }

      key = key.trim().toLowerCase().
        replace(/\s/g, '-').
        replace(/:$/, '');

      if (!key) {
        continue;
      }

      if (!value) {
        stack[depth][key] = {};
        stack[depth + 1] = stack[depth][key];
        last = depth;
      } else {
        value = value.trim();

        if (value === 'True' || value === 'true') {
          value = true;
        } else if (value === 'False' || value === 'false') {
          value = false;
        } else if (value === 'Undefined' || value === 'undefined') {
          value = undefined;
        } else if (Number(value).toString() === value) {
          value = Number(value);
        }

        stack[depth][key] = value;

        if (key === 'geometry') {
          stack[depth].width = parseInt(value.replace(/^(\d+)x\d+\+.*$/, '$1'), 10);
          stack[depth].height = parseInt(value.replace(/^\d+x(\d+)\+.*$/, '$1'), 10);
          stack[depth].aspect = stack[depth].width / stack[depth].height;
        }
      }
    }

    return object;
  }

  async examine (file) {
    this.indexer.log.verbose(`examining ${ file }`);
    const stat = await fs.stat(file);

    this.indexer.log.verbose(`probing detailed information for ${ file }`);

    const identifyArgs = this.config.identity.
      trim().
      split(/\s+/).
      map((arg) => arg.replace('$input', file));

    const { stdout } = await execFile(this.config.identify, identifyArgs);
    const data = stdout.trim().split(/\n/);
    data.shift();

    const details = this.identifyParser(data, {});

    return [ stat, details ];
  }

  //////////

  async converter ({ file, slot }) {
    const skip = await this.common.skip(file);
    if (skip) {
      return;
    }

    const [ , name, extension ] = file.match(/([^/]+)\.([^.]+)$/);

    this.common.spinner(slot, '  Fingerprinting $name ', `${ name }.${ extension }`);

    this.indexer.log.verbose(`hashing ${ file }`);
    const { stdout: sha } = await execFile(this.config.shasum, [ file ]);

    const [ id ] = sha.trim().split(/\s+/);

    this.indexer.log.verbose(`hashed ${ file }: ${ id }`);

    const occurrence = {
      id,
      file,
      path: file.replace(/\/([^/]+)$/, '/'),
      name,
      extension,
    };

    for (let i = 0; i < this.indexer.slots.length; i++) {
      if (this.indexer.slots[i] && this.indexer.slots[i].index !== slot.index && this.indexer.slots[i].id === id) {
        this.indexer.log.verbose(`slot ${ i } is already processing ${ id }`);
        this.indexer.slots[i].occurrences.push(occurrence);
        return;
      }
    }

    slot.id = id;
    slot.occurrences = [ occurrence ];

    const item = await this.common.lookup(id);

    if (item) {
      this.indexer.log.verbose(`match for ${ id } found`);
      await this.common.duplicate(item, occurrence);
      return;
    }

    this.indexer.log.verbose(`no match for ${ id }`);
    const [ stat, details ] = await this.examine(file);

    slot.spinner.stop();

    if (details.width < this.config.thresholds.minimum.width ||
        details.height < this.config.thresholds.minimum.height) {
      this.indexer.log.verbose(`[image] ${ file } below size threshold ${ details.width }x${ details.height } < ${ this.config.thresholds.minimum.width }x${ this.config.thresholds.minimum.height }`);
      return;
    } else if (details.width > this.config.thresholds.maximum.width ||
        details.height > this.config.thresholds.maximum.height) {
      this.indexer.log.verbose(`[image] ${ file } above size threshold ${ details.width }x${ details.height } > ${ this.config.thresholds.maximum.width }x${ this.config.thresholds.maximum.height }`);
      return;
    }

    this.common.spinner(slot, '  Generating thumbnail and metadata for $name ', `${ name }.${ extension }`);

    occurrence.size = stat.size;
    occurrence.timestamp = new Date(stat.mtime).getTime();

    const directory = join(this.config.save, id.substring(0, 2));
    const filename = id.substring(2);

    const output = join(directory, `${ filename }.${ extension.toLowerCase() }`);
    const thumbnail = join(directory, `${ filename }p.${ this.config.thumbnail.format }`);

    await fs.mkdir(directory, { recursive: true });

    this.indexer.log.verbose(`${ output } - ${ thumbnail }`);

    await fs.copyFile(file, output);
    await fs.chmod(output, this.config.mode);

    const thumbnailArgs = this.config.resize.
      trim().
      split(/\s+/).
      map((arg) => arg.replace('$thumbnail', thumbnail).
        replace('$input', output).
        replace('$geometry', `${ this.config.thumbnail.width }x${ this.config.thumbnail.height }`));

    this.indexer.log.verbose(`generating thumbnail ${ thumbnail }`);
    await execFile(this.config.convert, thumbnailArgs);
    await fs.chmod(thumbnail, this.config.mode);
    this.indexer.log.verbose(`generated thumbnail ${ thumbnail }`);

    let preview = false;
    if (extension === 'gif') {
      preview = join(directory, `${ filename }p.gif`);
      const previewArgs = this.config.preview.
        trim().
        split(/\s+/).
        map((arg) => arg.replace('$preview', preview).
          replace('$input', output).
          replace('$geometry', `${ this.config.thumbnail.width }x${ this.config.thumbnail.height }`));

      this.indexer.log.verbose(`generating preview ${ preview }`);
      await execFile(this.config.convert, previewArgs);
      await fs.chmod(preview, this.config.mode);
      this.indexer.log.verbose(`generated preview ${ preview }`);
    }

    const model = this.model({
      id,
      hash: id,
      occurrence,
      occurrences: slot.occurrences,
      output,
      stat,
      thumbnail,
      preview,
      details,
    });

    await this.common.tag(model);

    if (this.indexer.config.services.elastic.enabled) {
      await this.indexer.elastic.client.index({
        index: this.config.index,
        id: model.id,
        body: {
          name: model.name,
          description: model.description,
        },
      });
      await this.indexer.elastic.client.indices.refresh({ index: this.config.index });
    }

    await this.common.insert(model);
    this.indexer.log.verbose(`inserted image ${ name } (${ id }) into db`);

    await this.common.delete(file);

    slot.spinner.stop();

    this.indexer.stats.images++;
    this.indexer.stats.converted++;

    this.indexer.log.info(`[image] indexed ${ file } -> ${ id }`);

    this.indexer.emit({
      type: 'indexed:image',
      data: model,
    });
  }
}

module.exports = Image;
