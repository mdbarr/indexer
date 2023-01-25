'use strict';

const fs = require('node:fs/promises');
const style = require('barrkeep/style');
const { Spinner } = require('barrkeep/progress');

const KEYS = [ 'canSkip', 'delete', 'dropTags', 'mode', 'save', 'shasum', 'tagger' ];

class Common {
  constructor (indexer, type, config) {
    this.indexer = indexer;
    this.type = type;
    this.config = config;

    for (const key of KEYS) {
      if (this.config[key] === undefined) {
        console.log(type, key);
        this.config[key] = this.indexer.config.options[key];
      }
    }
  }

  database () {
    if (!this.collection) {
      this.collection = this.indexer.database.collections[this.type] ||
        this.indexer.database.collections.media;
    }
    return this.collection;
  }

  async delete (file) {
    if (this.shouldDelete(file)) {
      this.indexer.log.verbose(`deleting ${ file }`);
      await fs.unlink(file);
      this.indexer.log.verbose(`deleted ${ file }`);
    }
  }

  async duplicate (model, occurrence) {
    this.indexer.log.verbose(`updating metadata for ${ model.id }`);
    this.indexer.stats.duplicates++;

    let found = false;
    for (const item of model.metadata.occurrences) {
      if (item.file === occurrence.file) {
        found = true;
        break;
      }
    }
    if (found) {
      this.indexer.log.verbose(`existing occurrence found for ${ occurrence.file }`);
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

    this.indexer.log.verbose(`updating tags for ${ occurrence.id }`);
    const update = await this.tag(model);

    await this.database().replaceOne({ id: model.id }, update);

    this.indexer.log.verbose(`metadata updated for ${ model.id }`);

    await this.delete(occurrence.file);

    this.indexer.emit({
      type: `duplicate:${ model.object }`,
      data: model,
    });

    return update;
  }

  async insert (model) {
    this.database().insertOne(model);
  }

  async lookup (id) {
    this.database().findOne({
      $or: [
        {
          sources: id,
          deleted: { $ne: true },
        }, { sources: id }, { id }, { hash: id },
      ],
    });
  }

  nameScroller (name) {
    const nameWidth = 25;
    let scrollStart = 0;
    let scrollFormat;

    const scrollName = (format) => {
      if (format) {
        scrollFormat = format;
        scrollStart = 0;
      }

      let shortName = name.replace(/[^\x00-\x7F]/g, '');
      if (shortName.length > 25) {
        shortName = shortName.substring(scrollStart, scrollStart + nameWidth);

        if (scrollStart < 0) {
          shortName = shortName.padStart(nameWidth, ' ');
        } else {
          shortName = shortName.padEnd(nameWidth, ' ');
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

    return scrollName;
  }

  shouldDelete (file) {
    if (typeof this.config.delete === 'function') {
      return this.config.delete(file);
    }
    return this.config.delete;
  }

  async skip (file) {
    if (this.config.canSkip && !this.shouldDelete(file)) {
      const model = await this.database().findOne({ 'metadata.occurrences.file': file });
      if (model) {
        this.indexer.log.verbose(`skipping file due to existing entry ${ file }`);
        this.indexer.stats.skipped++;

        this.indexer.emit({
          type: `skipped:${ model.object }`,
          data: {
            model,
            file,
          },
        });

        return true;
      }
    }
    return false;
  }

  spinner (slot, format, name) {
    const scrollName = this.nameScroller(name);

    let slow = 0;

    slot.spinner = new Spinner({
      prepend: scrollName(format),
      spinner: 'dots4',
      style: 'fg: DodgerBlue1',
      x: 0,
      y: slot.y,
    });

    slot.spinner.onTick = () => {
      if (slow % 2 === 0) {
        slot.spinner.prepend = scrollName();
      }
      slow++;
    };

    slot.spinner.start();
  }

  async tag (model) {
    if (typeof this.config.tagger !== 'function') {
      return model;
    }

    this.indexer.log.verbose(`tagging ${ model.name }`);

    await this.config.tagger(model, this.indexer.config);
    model.metadata.updated = Date.now();
    return model;
  }
}

module.exports = Common;
