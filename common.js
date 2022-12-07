'use strict';

const fs = require('node:fs/promises');
const style = require('barrkeep/style');
const { Spinner } = require('barrkeep/progress');

function Common (indexer, config) {
  this.configure = () => {
    const keys = [ 'shasum', 'save', 'delete', 'canSkip', 'dropTags', 'tagger' ];

    for (const key of keys) {
      if (config[key] === undefined) {
        config[key] = indexer.config[key];
      }
    }
  };

  this.delete = async (file) => {
    if (this.shouldDelete(file)) {
      indexer.log.verbose(`deleting ${ file }`);
      await fs.unlink(file);
      indexer.log.verbose(`deleted ${ file }`);
    }
  };

  this.duplicate = async (model, occurrence) => {
    indexer.log.verbose(`updating metadata for ${ model.id }`);
    indexer.stats.duplicates++;

    let found = false;
    for (const item of model.metadata.occurrences) {
      if (item.file === occurrence.file) {
        found = true;
        break;
      }
    }
    if (found) {
      indexer.log.verbose(`existing occurrence found for ${ occurrence.file }`);
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

    indexer.log.verbose(`updating tags for ${ occurrence.id }`);
    const update = await this.tag(model);

    await indexer.database.media.replaceOne({ id: model.id }, update);

    indexer.log.verbose(`metadata updated for ${ model.id }`);

    await this.delete(occurrence.file);

    return update;
  };

  this.lookup = async (id) => indexer.database.media.findOne({
    $or: [
      {
        sources: id,
        deleted: { $ne: true },
      }, { sources: id }, { id }, { hash: id },
    ],
  });

  this.nameScroller = (name) => {
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
  };

  this.shouldDelete = (file) => {
    if (typeof config.delete === 'function') {
      return config.delete(file);
    }
    return config.delete;
  };

  this.skipFile = async (file) => {
    if (config.canSkip && !this.shouldDelete(file)) {
      const item = await indexer.database.media.findOne({ 'metadata.occurrences.file': file });
      return Boolean(item);
    }
    return false;
  };

  this.spinner = (slot, format, name) => {
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
  };

  this.tag = async (model) => {
    if (typeof config.tagger !== 'function') {
      return model;
    }

    indexer.log.verbose(`tagging ${ model.name }`);

    await config.tagger(model, indexer.config);
    model.metadata.updated = Date.now();
    return model;
  };
}

module.exports = (indexer, options) => new Common(indexer, options);
