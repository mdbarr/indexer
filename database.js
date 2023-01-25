'use strict';

const async = require('async');
const { MongoClient } = require('mongodb');

function Database (indexer, options) {
  this.createIndexes = async (collection) => {
    if (options.dropIndex || options.dropIndexes) {
      await collection.dropIndexes();
    }

    await collection.createIndexes([
      {
        key: { id: 1 },
        unique: true,
      },
      { key: { sources: 1 } },
      {
        key: {
          name: 'text',
          'metadata.occurrences.name': 'text',
          description: 'text',
        },
        weights: {
          name: 10,
          'metadata.occurrences.name': 5,
          description: 1,
        },
      },
    ]);
  };

  this.start = async () => {
    this.client = new MongoClient(indexer.config.services.database.url, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    indexer.log.info(`Database connecting to ${ indexer.config.services.database.url }...`);
    await this.client.connect();
    this.db = this.client.db();

    this.collections = { media: this.db.collection(indexer.config.services.database.collection || 'media') };
    await this.createIndexes(this.collections.media);

    await async.eachOf(indexer.config.types, async (config, type) => {
      if (config.collection) {
        this.collections[type] = this.db.collection(config.collection);
        await this.createIndexes(this.collections[type]);
      }
    });

    indexer.log.info(`Database successfully connected to ${ indexer.config.services.database.url }`);
  };

  this.stop = async () => await this.client.close();
}

module.exports = (indexer, options) => new Database(indexer, options);
