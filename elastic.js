'use strict';

const { Client } = require('@elastic/elasticsearch');

function Elastic (indexer) {
  this.start = (callback) => {
    indexer.log.info(`ElasticSearch connecting to ${ indexer.config.services.elastic.node }...`);

    this.client = new Client({ node: indexer.config.services.elastic.node });

    return this.client.info().
      then((info) => {
        indexer.log.info(`ElasticSearch successfully connected to ${ info.meta.connection.url }`);
        return callback();
      }).
      catch((error) => callback(error));
  };
}

module.exports = (indexer) => new Elastic(indexer);
