'use strict';

const { MongoClient } = require('mongodb');

function Database (indexer) {
  this.start = (callback) => {
    this.client = new MongoClient(indexer.config.database.url, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    indexer.log.info(`Database connecting to ${ indexer.config.database.url }...`);
    return this.client.connect((error) => {
      if (error) {
        return callback(error);
      }

      this.db = this.client.db();

      this.media = this.db.collection(indexer.config.database.collection);

      return this.media.createIndexes([
        {
          key: { id: 1 },
          unique: true,
        }, { key: { sources: 1 } }, {
          key: {
            name: 'text',
            description: 'text',
          },
        },
      ], (error) => {
        if (error) {
          return callback(error);
        }

        indexer.log.info(`Database successfully connected to ${ indexer.config.database.url }`);
        return callback(null);
      });
    });
  };

  this.stop = (callback) => this.client.close(callback);
}

module.exports = (indexer) => new Database(indexer);
