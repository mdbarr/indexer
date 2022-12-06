'use strict';

const style = require('barrkeep/style');

function Common (indexer, config) {
  this.duplicate = async (model, occurrence) => {
    indexer.log.info(`updating metadata for ${ model.id }`);
    indexer.stats.duplicates++;

    let found = false;
    for (const item of model.metadata.occurrences) {
      if (item.file === occurrence.file) {
        found = true;
        break;
      }
    }
    if (found) {
      indexer.log.info(`existing occurrence found for ${ occurrence.file }`);
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

    indexer.log.info(`updating tags for ${ occurrence.id }`);
    const update = await this.tag(model);

    await indexer.database.media.replaceOne({ id: model.id }, update);

    indexer.log.info(`metadata updated for ${ model.id }`);

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

  this.nameScroller = (name, extension) => {
    const nameWidth = 25;
    let scrollStart = 0;

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

  this.tag = async (model) => {
    if (typeof config.tagger !== 'function') {
      return model;
    }

    indexer.log.info(`tagging ${ model.name }`);

    await config.tagger(model, indexer.config);
    model.metadata.updated = Date.now();
    return model;
  };
}

module.exports = (indexer, options) => new Common(indexer, options);
