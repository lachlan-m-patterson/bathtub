export const waterVertexShader = `
attribute float surface;
uniform float datum;
uniform float verticalScale;
varying float vDepth;
varying vec2 vPosition;
varying vec2 vGridUv;
void main() {
  vDepth = surface - (position.y / verticalScale + datum);
  vPosition = position.xz;
  vGridUv = vec2(uv.x, 1.0 - uv.y);
  vec3 p = position;
  p.y = (surface - datum) * verticalScale;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

export const waterFragmentShader = `
uniform float time;
uniform float smoothShoreline;
uniform sampler2D shorelineDepth;
uniform vec2 gridSize;
varying float vDepth;
varying vec2 vPosition;
varying vec2 vGridUv;

vec4 cubicWeights(float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return vec4(-0.5*t + t2 - 0.5*t3,
              1.0 - 2.5*t2 + 1.5*t3,
              0.5*t + 2.0*t2 - 1.5*t3,
              -0.5*t2 + 0.5*t3);
}

float curvedDepth(vec2 uv) {
  vec2 grid = uv * (gridSize - 1.0);
  vec2 base = floor(grid);
  vec4 wx = cubicWeights(fract(grid.x));
  vec4 wy = cubicWeights(fract(grid.y));
  float value = 0.0;
  float low = 1.0e10;
  float high = -1.0e10;
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      vec2 sampleUv = (clamp(base + vec2(float(x - 1), float(y - 1)), vec2(0.0), gridSize - 1.0) + 0.5) / gridSize;
      float depth = texture2D(shorelineDepth, sampleUv).r;
      value += depth * wx[x] * wy[y];
      low = min(low, depth);
      high = max(high, depth);
    }
  }
  return clamp(value, low, high);
}

// Display-space colours on the existing continuous 0–6 m depth scale.
vec3 floodColour(float depth) {
  vec3 shallow = vec3(220, 239, 234) / 255.0;
  vec3 lightTeal = vec3(166, 213, 205) / 255.0;
  vec3 teal = vec3(101, 173, 169) / 255.0;
  vec3 darkTeal = vec3(39, 122, 128) / 255.0;
  vec3 deep = vec3(18, 76, 89) / 255.0;
  float t = clamp(depth / 6.0, 0.0, 1.0) * 4.0;
  vec3 colour = mix(shallow, lightTeal, min(t, 1.0));
  colour = mix(colour, teal, clamp(t - 1.0, 0.0, 1.0));
  colour = mix(colour, darkTeal, clamp(t - 2.0, 0.0, 1.0));
  return mix(colour, deep, max(t - 3.0, 0.0));
}

void main() {
  // Trim the piecewise-linear contour with a curved interpolation. The original
  // wet surface remains the outer limit, so smoothing never adds flooded land.
  float depth = vDepth;
  if (smoothShoreline > 0.5 && vDepth < 1.0) depth = min(depth, curvedDepth(vGridUv));
  float feather = max(0.04, fwidth(depth) * 1.25);
  float coverage = smoothstep(0.015, 0.015 + feather, depth);
  if (smoothShoreline < 0.5) coverage = step(0.015, vDepth);
  if (coverage < 0.01) discard;
  float ripple = sin(vPosition.x*.07 + vPosition.y*.05 - time*.7)
               * sin(vPosition.y*.11 - time*.5) * .009;
  vec3 water = floodColour(vDepth);
  float opacity = mix(.52,.94,smoothstep(0.0,3.0,vDepth));
  gl_FragColor = vec4(water + ripple, opacity * coverage);
}`;
