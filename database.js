'use strict';

const { MongoClient } = require('mongodb');

function Database (indexer, options) {
  const dropIndex = async () => {
    if (options.dropIndex || options.dropIndexes) {
      await this.media.dropIndexes();
    }
  };

  this.start = async () => {
    this.client = new MongoClient(indexer.config.services.database.url, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    indexer.log.info(`Database connecting to ${ indexer.config.services.database.url }...`);
    await this.client.connect();
    this.db = this.client.db();

    this.media = this.db.collection(indexer.config.services.database.collection);

    await dropIndex();

    await this.media.createIndexes([
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

    indexer.log.info(`Database successfully connected to ${ indexer.config.services.database.url }`);
  };

  this.stop = async () => await this.client.close();
}

module.exports = (indexer, options) => new Database(indexer, options);
