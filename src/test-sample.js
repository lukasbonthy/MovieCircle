const { extractFirstProxyVideo } = require('./extractor');

const sample = 'ttps://filmubox.lemonforest-715663af.southeastasia.azurecontainerapps.io/proxy/video?url=https://bcdnxw.hakunaymatata.com/resource/a74ce4502f7da06879dfd949e3ac7f35.mp4?sign=4c939e201ce7f47280d2bf4bc705964a&t=1778462447&apikey=filmu_moviebox_key_v1&referer=https://fmoviesunblocked.net/&origin=https://fmoviesunblocked.net';

const result = extractFirstProxyVideo(sample);
if (!result) {
  console.error('FAILED: no proxy-video found');
  process.exit(1);
}

if (!result.workingEncodedProxyUrl.includes('url=https%3A%2F%2Fbcdnxw.hakunaymatata.com')) {
  console.error('FAILED: video URL was not encoded correctly');
  console.error(result);
  process.exit(1);
}

if (!result.workingEncodedProxyUrl.includes('%26t%3D1778462447')) {
  console.error('FAILED: t param was not preserved inside encoded video URL');
  console.error(result);
  process.exit(1);
}

console.log('PASS');
console.log(result.workingEncodedProxyUrl);
