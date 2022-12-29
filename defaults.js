'use strict';

const os = require('node:os');
const { join } = require('node:path');

const version = require('./package.json').version;

module.exports = {
  name: `Indexer v${ version }`,
  version,
  logs: {
    clear: true,
    combined: join(process.cwd(), 'indexer.log'),
    error: join(process.cwd(), 'error.log'),
  },
  options: {
    cache: join(os.tmpdir(), '.indexer.cache'),
    canSkip: true,
    concurrency: 2,
    delete: false,
    dropTags: false,
    save: join(os.tmpdir(), 'indexer'),
    scan: process.cwd(),
    shasum: '/usr/bin/md5sum',
    tagger: async (model, config) => {
      if (config.dropTags) {
        model.metadata.tags = [];
      }

      if (Array.isArray(model.metadata.tags) && model.metadata.tags.length === 0) {
        model.metadata.tags.push('untagged');
      }

      return model;
    },
  },
  scanner: {
    exclude: [ '**/node_modules/**' ],
    persistent: false,
    rescan: 3600000,
    sort: false,
  },
  services: {
    database: {
      url: 'mongodb://localhost:27017/indexer',
      collection: 'media',
    },
    elastic: { node: 'http://localhost:9200' },
  },
  types: {
    image: {
      enabled: true,
      pattern: /\.(gif|png|jpeg|jpg|tiff)$/i,
      exclude: /thumbs/i,
      convert: '/usr/bin/convert',
      identify: '/usr/bin/identify',
      identity: '-verbose $input[0]',
      index: 'media-image',
      preview: '$input -thumbnail $geometry $preview',
      resize: '$input[0] -coalesce -thumbnail $geometry $thumbnail',
      thumbnail: {
        format: 'png',
        width: 320,
        height: 180,
      },
    },
    text: {
      enabled: false,
      pattern: /\.(text|txt)$/i,
      compression: 'brotli',
      index: 'media-text',
      processor: null,
      summarize: 5,
      summaryFallback: 1000,
      thresholds: {
        minimum: 1024, // 1KB
        maximum: 5242880, // 5MB
      },
    },
    video: {
      enabled: false,
      pattern: /\.(asf|avi|divx|flv|mkv|mov|mpe?g|mp4|mts|m[14]v|ts|vob|webm|wmv|3gp)$/i,
      checkSound: true,
      convert: '-i $input -f $format -vcodec h264 -acodec aac -pix_fmt yuv420p -profile:v' +
        ' baseline -level 3 -vsync 1 -r $framerate -avoid_negative_ts 1 -fflags +genpts' +
        ' -map_chapters -1 -max_muxing_queue_size 99999 -vf pad=ceil(iw/2)*2:ceil(ih/2)*2' +
        ' -analyzeduration 2147483647 -probesize 2147483647 $output -hide_banner -y',
      ffmpeg: '/usr/bin/ffmpeg',
      ffprobe: '/usr/bin/ffprobe',
      format: 'mp4',
      framerate: 30,
      index: 'media-video',
      preview: '-i $input -an -max_muxing_queue_size 99999 -vcodec libx264 -pix_fmt yuv420p' +
        " -profile:v baseline -level 3 -vf select='lt(mod(t,$interval),1)'," +
        'setpts=N/FRAME_RATE/TB,pad=ceil(iw/2)*2:ceil(ih/2)*2 $output -y -hide_banner',
      previewDuration: 30,
      probe: '-v quiet -print_format json -show_format -show_streams -print_format json $file',
      sound: '-i $file -af volumedetect -f null -max_muxing_queue_size 99999 /dev/null',
      soundThreshold: -90,
      subtitle: '-i $input -map 0:m:language:$language? $output -y',
      subtitleFallback: '-i $input $output -y',
      subtitleFormat: 'srt',
      subtitleLanguage: 'eng',
      subtitlesIndex: 'media-video-subtitles',
      subtitlesToDescription: true,
      thumbnail: '-i $output -ss 00:00:$time -vframes 1 $thumbnail -y',
      thumbnailFormat: 'png',
      thumbnailTime: 5,
    },
  },
};
