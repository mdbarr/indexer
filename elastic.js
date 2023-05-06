'use strict';

const { Client } = require('@elastic/elasticsearch');

function Elastic (indexer) {
  this.start = async () => {
    if (indexer.config.services.elastic.enabled) {
      indexer.log.info(`ElasticSearch connecting to ${ indexer.config.services.elastic.node }...`);

      this.client = new Client({ node: indexer.config.services.elastic.node });

      const info = await this.client.info();
      indexer.log.info(`ElasticSearch successfully connected to ${ info.meta.connection.url }`);
    }
  };

  this.stop = async () => {
    if (indexer.config.services.elastic.enabled) {
      await this.client.close();
    }
  };
}

module.exports = (indexer) => new Elastic(indexer);
