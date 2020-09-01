'use strict';

const os = require('os');
const { join } = require('path');

const version = require('./package.json').version;

module.exports = {
  name: `Indexer v${ version }`,
  version,
  scan: process.cwd(),
  types: {
    image: {
      pattern: /\.(gif|png|jepg|jpg|tiff)$/i,
      enabled: false,
    },
    text: {
      pattern: /\.(md|text|txt)$/i,
      enabled: false,
    },
    video: {
      pattern: /\.(asf|avi|divx|flv|mkv|mov|mpe?g|mp4|mts|m[14]v|ts|vob|webm|wmv|3gp)$/i,
      enabled: true,
    },
  },
  exclude: [ '**/node_modules/**' ],
  sort: false,
  db: 'mongodb://localhost:27017/indexer',
  collection: 'media',
  concurrency: 2,
  rescan: 3600000,
  persistent: false,
  video: {
    shasum: '/usr/bin/md5sum',
    ffmpeg: '/usr/bin/ffmpeg',
    convert: '-i $input -f $format -vcodec h264 -acodec aac -pix_fmt yuv420p -profile:v' +
      ' baseline -level 3 -vsync 1 -r $framerate -avoid_negative_ts 1 -fflags +genpts' +
      ' -max_muxing_queue_size 99999 -vf pad=ceil(iw/2)*2:ceil(ih/2)*2' +
      ' -analyzeduration 2147483647 -probesize 2147483647 $output -hide_banner -y',
    convertSubtitles: '-i $input -f $format -vcodec h264 -acodec aac -pix_fmt yuv420p -profile:v' +
      ' baseline -level 3 -vsync 1 -r $framerate -avoid_negative_ts 1 -fflags +genpts' +
      " -max_muxing_queue_size 99999 -filter_complex subtitles='$input'" +
      ' -analyzeduration 2147483647 -probesize 2147483647 $output -hide_banner -y',
    format: 'mp4',
    framerate: 30,
    thumbnailFormat: 'png',
    thumbnailTime: 5,
    thumbnail: '-i $output -ss 00:00:$time -vframes 1 $thumbnail -y',
    sound: '-t $duration -i $file -af volumedetect -f null -max_muxing_queue_size 99999 /dev/null',
    soundDuration: 300,
    preview: '-i $input -an -max_muxing_queue_size 99999 -vcodec libx264 -pix_fmt yuv420p' +
      " -profile:v baseline -level 3 -vf select='lt(mod(t,$interval),1)'," +
      'setpts=N/FRAME_RATE/TB,pad=ceil(iw/2)*2:ceil(ih/2)*2 $output -y -hide_banner',
    previewDuration: 30,
    ffprobe: '/usr/bin/ffprobe',
    probe: '-v quiet -print_format json -show_format -show_streams -print_format json $file',
    save: join(os.tmpdir(), 'indexer'),
    checkSound: true,
    delete: false,
    canSkip: true,
    dropTags: false,
    tagger: (model, config, callback) => {
      if (config.dropTags) {
        model.metadata.tags = [];
      }
      if (Array.isArray(model.metadata.tags) && model.metadata.tags.length === 0) {
        model.metadata.tags.push('untagged');
      }

      setImmediate(callback, null, model);
    },
  },
  logs: {
    combined: join(process.cwd(), 'indexer.log'),
    error: join(process.cwd(), 'error.log'),
  },
};
