'use strict';

const { MongoClient } = require('mongodb');

function Database (indexer, options) {
  const dropIndex = (callback) => {
    if (options.dropIndex || options.dropIndexes) {
      return this.media.dropIndexes(callback);
    }
    return setImmediate(callback);
  };

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

      return dropIndex((error) => {
        if (error) {
          return callback(error);
        }

        return this.media.createIndexes([
          {
            key: { id: 1 },
            unique: true,
          },
          { key: { sources: 1 } },
          {
            key: {
              'name': 'text',
              'metadata.occurrences.name': 'text',
              'description': 'text',
            },
            weights: {
              'name': 10,
              'metadata.occurrences.name': 5,
              'description': 1,
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
    });
  };

  this.stop = (callback) => this.client.close(callback);
}

module.exports = (indexer, options) => new Database(indexer, options);
