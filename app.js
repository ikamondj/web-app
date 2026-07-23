(() => {
  'use strict';

  /*
   * Exact WebGL port of the supplied C++ predicate rasterizer.
   *
   * The GPU renders the same logical HUB75 framebuffer as the C++ code. Its
   * default size is 64x32 and can be overridden with the width query parameter.
   * This includes renderFrame()'s outer 2x2 supersampling, rast()'s independent
   * 1x1/2x2/3x3 predicate coverage, coverage falloff, component order, and final
   * 8-bit rounding. Blink and pupil motion remain CPU-side because the C++
   * implementation stores them as persistent static state and advances one
   * shared deterministic xorshift32 sequence.
   */

  const canvas = document.getElementById('glcanvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('Expected a <canvas id="glcanvas"> element.');
  }

  const installButton = document.getElementById('installButton');
  const recenterButton = document.getElementById('recenterButton');
  const leftJoy = document.getElementById('leftJoy');
  const rightJoy = document.getElementById('rightJoy');
  const leftKnob = document.getElementById('leftKnob');
  const rightKnob = document.getElementById('rightKnob');

  const queryParameters = new URLSearchParams(window.location.search);
  const SHOW_HUD = queryParameters.get('hud') === '1';
  const requestedWidth = queryParameters.get('width');
  const parsedWidth =
    requestedWidth !== null && /^\d+$/.test(requestedWidth)
      ? Number(requestedWidth)
      : Number.NaN;
  const MATRIX_WIDTH =
    Number.isInteger(parsedWidth) &&
    parsedWidth >= 16 &&
    parsedWidth <= 1024 &&
    parsedWidth % 2 === 0
      ? parsedWidth
      : 64;
  const MATRIX_HEIGHT = MATRIX_WIDTH / 2;
  const WORLD_WIDTH = 3.0;
  const WORLD_HEIGHT = 1.5;
  const PIXEL_WIDTH = WORLD_WIDTH / MATRIX_WIDTH;
  const PIXEL_HEIGHT = WORLD_HEIGHT / MATRIX_HEIGHT;
  const CONTROLLER_DEADZONE = 0.15;

  canvas.dataset.rendererWidth = String(MATRIX_WIDTH);
  canvas.dataset.rendererHeight = String(MATRIX_HEIGHT);
  document.documentElement.classList.toggle('hide-hud', !SHOW_HUD);

  const hudElements = document.querySelectorAll('.hud, .pad-stack');
  for (const element of hudElements) {
    element.hidden = !SHOW_HUD;
    element.setAttribute('aria-hidden', String(!SHOW_HUD));
  }

  const parsedAntialiasingLevel = Number.parseInt(
    canvas.dataset.antialiasingLevel || '1',
    10,
  );

  const ANTIALIASING_LEVEL = Number.isFinite(parsedAntialiasingLevel)
    ? Math.max(1, Math.min(3, parsedAntialiasingLevel))
    : 1;

  // Set data-cpp-integer-abs="true" on the canvas only when the native build
  // is GCC/Clang and is intentionally preserving the source's unqualified
  // abs(float) -> abs(int) conversion. The default matches floating abs as in
  // MSVC/Arduino-like builds and the apparent geometry intent of the source.
  const CPP_INTEGER_ABS_COMPATIBILITY =
    canvas.dataset.cppIntegerAbs === 'true';

  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });

  if (!gl) {
    document.body.innerHTML = '<h1>WebGL is required to view this app.</h1>';
    throw new Error('WebGL unavailable');
  }

  const fragmentPrecision = gl.getShaderPrecisionFormat(
    gl.FRAGMENT_SHADER,
    gl.HIGH_FLOAT,
  );

  if (!fragmentPrecision || fragmentPrecision.precision === 0) {
    throw new Error(
      'High-precision fragment floats are required for exact raster parity.',
    );
  }

  const fullscreenVertexShaderSource = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

  const rasterFragmentShaderTemplate = `
precision highp float;

uniform vec2 u_matrixSize;
uniform vec2 u_pixelSize;
uniform vec2 u_joystick1;
uniform vec2 u_joystick2;
uniform vec2 u_pupilGaze;
uniform float u_blink;

const float RAST_GRID_SIZE = __RAST_GRID_SIZE__;
const bool CPP_INTEGER_ABS_COMPATIBILITY = __CPP_INTEGER_ABS__;

const float EPSILON = 0.000001;
const float ANTIALIASING_COVERAGE_FALLOFF = 1.3;

const float EYE_SPACING = 0.65;
const float PUPIL_RADIUS_SQR = 0.01;
const float SCLERA_RADIUS_SQR = 0.0035;
const float INNER_PUPIL_RADIUS_SQR = 0.0001;
const float PUPIL_VISIBLE_INSET = 0.04;

const vec3 BACKGROUND_COLOR = vec3(0.0, 0.0, 0.0);
const vec3 EYE_COLOR = vec3(1.0, 1.0, 0.0);
const vec3 PUPIL_COLOR = vec3(0.0, 1.0, 1.0);
const vec3 SCLERA_COLOR = vec3(1.0, 1.0, 1.0);
const vec3 INNER_PUPIL_COLOR = vec3(0.0, 0.0, 0.0);
const vec3 BROW_COLOR = vec3(0.0, 1.0, 1.0);
const vec3 MOUTH_COLOR = vec3(0.0, 1.0, 1.0);
const vec3 TOOTH_COLOR = vec3(1.0, 1.0, 0.0);
const vec3 TONGUE_COLOR = vec3(1.0, 0.0, 1.0);
const vec3 TOP_BANGS_COLOR = vec3(1.0, 0.0, 1.0);
const vec3 BOTTOM_BANGS_COLOR = vec3(1.0, 1.0, 0.0);

float cppUnqualifiedAbs(float value) {
  // The supplied .cpp uses unqualified abs() in a few places. GCC resolves
  // those calls to integer abs, while MSVC/Arduino-style environments often
  // provide a floating overload/macro. This switch can reproduce either build.
  return CPP_INTEGER_ABS_COMPATIBILITY
    ? floor(abs(value))
    : abs(value);
}

float saturateValue(float value) {
  return clamp(value, 0.0, 1.0);
}

float lerpFloat(float a, float b, float amount) {
  return a + (b - a) * amount;
}

float smoothstep01(float value) {
  float t = saturateValue(value);
  return t * t * (3.0 - 2.0 * t);
}

float dlerp(
  float center,
  float left,
  float right,
  float up,
  float down,
  float joystickX,
  float joystickY
) {
  float x = clamp(joystickX, -1.0, 1.0);
  float y = clamp(joystickY, -1.0, 1.0);

  float verticalValue = y < 0.0
    ? lerpFloat(center, down, -y)
    : lerpFloat(center, up, y);

  float horizontalValue = x < 0.0
    ? left
    : right;

  return lerpFloat(
    verticalValue,
    horizontalValue,
    abs(x)
  );
}

float cross2(vec2 a, vec2 b) {
  return a.x * b.y - a.y * b.x;
}

bool satisfiesBulgedTriangleSide(
  vec2 point,
  vec2 sideStart,
  vec2 sideEnd,
  vec2 oppositeVertex,
  float orientation,
  float bulge
) {
  vec2 edge = sideEnd - sideStart;
  float edgeLength = length(edge);

  if (edgeLength < EPSILON) {
    return false;
  }

  float lineConstraint =
    -orientation *
    cross2(edge, point - sideStart) /
    edgeLength;

  float radius = 0.5 * (
    distance(oppositeVertex, sideStart) +
    distance(oppositeVertex, sideEnd)
  );

  if (radius < EPSILON) {
    return false;
  }

  float circleConstraint =
    distance(point, oppositeVertex) -
    radius;

  float blendedConstraint =
    lineConstraint +
    (circleConstraint - lineConstraint) *
    bulge;

  return blendedConstraint <= EPSILON;
}

bool inTri(
  vec2 point,
  vec2 vertex1,
  vec2 vertex2,
  vec2 vertex3,
  float bulge
) {
  bulge = clamp(bulge, 0.0, 1.0);

  float triangleWinding =
    cross2(
      vertex2 - vertex1,
      vertex3 - vertex1
    );

  if (abs(triangleWinding) < EPSILON) {
    return false;
  }

  float orientation =
    triangleWinding > 0.0
      ? 1.0
      : -1.0;

  return
    satisfiesBulgedTriangleSide(
      point,
      vertex1,
      vertex2,
      vertex3,
      orientation,
      bulge
    ) &&
    satisfiesBulgedTriangleSide(
      point,
      vertex2,
      vertex3,
      vertex1,
      orientation,
      bulge
    ) &&
    satisfiesBulgedTriangleSide(
      point,
      vertex3,
      vertex1,
      vertex2,
      orientation,
      bulge
    );
}

bool convexEdgeContains(
  vec2 point,
  vec2 previous,
  vec2 current
) {
  vec2 edge = current - previous;
  vec2 pointOffset = point - previous;

  return cross2(edge, pointOffset) >= -EPSILON;
}

bool inConvex3(
  vec2 point,
  vec2 v0,
  vec2 v1,
  vec2 v2
) {
  return
    convexEdgeContains(point, v2, v0) &&
    convexEdgeContains(point, v0, v1) &&
    convexEdgeContains(point, v1, v2);
}

bool inConvex4(
  vec2 point,
  vec2 v0,
  vec2 v1,
  vec2 v2,
  vec2 v3
) {
  return
    convexEdgeContains(point, v3, v0) &&
    convexEdgeContains(point, v0, v1) &&
    convexEdgeContains(point, v1, v2) &&
    convexEdgeContains(point, v2, v3);
}

bool inConvex5(
  vec2 point,
  vec2 v0,
  vec2 v1,
  vec2 v2,
  vec2 v3,
  vec2 v4
) {
  return
    convexEdgeContains(point, v4, v0) &&
    convexEdgeContains(point, v0, v1) &&
    convexEdgeContains(point, v1, v2) &&
    convexEdgeContains(point, v2, v3) &&
    convexEdgeContains(point, v3, v4);
}

float eyeUpper(
  float absoluteX,
  float blink,
  float blinkability
) {
  if (absoluteX < 0.4 || absoluteX > 1.0) {
    return -5.0;
  }

  float cbrtInput =
    0.7 * absoluteX -
    0.35;

  float defOpen =
    sign(cbrtInput) *
    pow(abs(cbrtInput), 1.0 / 3.0) -
    0.05;

  float contenta =
    1.97 *
    (absoluteX - 0.4) *
    (absoluteX - 0.4) -
    0.05;

  float sloffset =
    absoluteX -
    0.7;

  float sleepy =
    -3.0 *
    sqrt(
      0.09 -
      sloffset * sloffset
    ) +
    0.91;

  float foffset =
    absoluteX -
    0.75;

  float fullopen =
    3.7 *
    sqrt(
      0.36 -
      foffset * foffset
    ) -
    1.6;

  float openUpper = dlerp(
    defOpen,
    contenta,
    defOpen,
    fullopen,
    sleepy,
    u_joystick1.x,
    u_joystick1.y
  );

  float flatBlink =
    1.4 * absoluteX -
    0.75;

  float blinkables = lerpFloat(
    openUpper,
    flatBlink,
    blink
  );

  return lerpFloat(
    openUpper,
    blinkables,
    blinkability
  );
}

float eyeLower(
  float absoluteX,
  float blink,
  float blinkability
) {
  if (absoluteX > 1.0) {
    return 5.0;
  }

  if (absoluteX < 0.4) {
    return -0.05;
  }

  float offset =
    absoluteX -
    0.5;

  float defopen =
    5.6 *
    offset *
    offset *
    offset -
    0.05;

  float sloffset =
    absoluteX -
    0.7;

  float sleepy =
    -2.3 *
    sqrt(
      0.09 -
      sloffset * sloffset
    ) +
    0.65;

  float foffset =
    absoluteX -
    0.63;

  float fullopen =
    -2.0 *
    sqrt(
      0.16 -
      foffset * foffset
    ) +
    0.71;

  float closedPosition =
    1.4 * absoluteX -
    0.75;

  float slimopen = lerpFloat(
    defopen,
    closedPosition,
    0.77
  );

  float openLower = dlerp(
    defopen,
    defopen,
    slimopen,
    fullopen,
    sleepy,
    u_joystick1.x,
    u_joystick1.y
  );

  float blinkables = lerpFloat(
    openLower,
    closedPosition,
    blink
  );

  return lerpFloat(
    openLower,
    blinkables,
    blinkability
  );
}

bool eyePredicate(
  vec2 point,
  float blink,
  float blinkability
) {
  float absoluteX = abs(point.x);

  if (absoluteX < 0.5 || absoluteX > 1.0) {
    return false;
  }

  float originalY =
    point.y +
    0.1;

  return
    eyeLower(
      absoluteX,
      blink,
      blinkability
    ) <
    originalY &&
    originalY <
    eyeUpper(
      absoluteX,
      blink,
      blinkability
    );
}

bool browPredicate(
  vec2 point,
  float blink,
  float blinkability
) {
  float blinkz =
    blink *
    blinkability;

  float bigEyeOffsetX = dlerp(
    0.0,
    0.081,
    -0.17,
    -0.1,
    0.0,
    u_joystick1.x,
    u_joystick1.y
  );

  float bigEyeOffsetY = dlerp(
    0.0,
    0.0,
    -0.14,
    -0.0315,
    -0.091,
    u_joystick1.x,
    u_joystick1.y
  );

  float activeOffsetX =
    bigEyeOffsetX *
    (1.0 - blinkz);

  float activeOffsetY =
    bigEyeOffsetY *
    (1.0 - blinkz);

  float blinkOffset =
    blinkz *
    0.15;

  bool inBottomBrow = inTri(
    point,
    vec2(
      0.560 +
      blinkOffset +
      activeOffsetX,

      0.391 -
      blinkOffset +
      activeOffsetY
    ),
    vec2(
      0.500 +
      blinkOffset +
      activeOffsetX,

      0.577 -
      blinkOffset +
      activeOffsetY
    ),
    vec2(
      0.650 +
      blinkOffset +
      activeOffsetX,

      0.510 -
      blinkOffset +
      activeOffsetY
    ),
    1.0
  );

  bool inTopBrow = inTri(
    point,
    vec2(
      0.713 +
      blinkOffset +
      activeOffsetX,

      0.550 -
      blinkOffset +
      activeOffsetY
    ),
    vec2(
      0.680 +
      blinkOffset +
      activeOffsetX,

      0.680 -
      blinkOffset +
      activeOffsetY
    ),
    vec2(
      0.840 +
      blinkOffset +
      activeOffsetX,

      0.580 -
      blinkOffset +
      activeOffsetY
    ),
    1.0
  );

  return
    inBottomBrow ||
    inTopBrow;
}

float mouthTop(float x) {
  if (cppUnqualifiedAbs(x) > 0.85) {
    return -5.0;
  }

  float openSmile =
    0.7 *
    x * x * x * x -
    0.55;

  float leftness =
    clamp(
      -u_joystick2.x,
      0.0,
      1.0
    );

  float cx =
    x *
    (
      1.0 -
      0.544355294118 *
      (1.0 - leftness)
    );

  float circleMouth =
    sqrt(
      0.15 -
      cx * cx
    ) -
    0.35;

  float uwumouth =
    0.3 *
    x * x -
    0.344 +
    0.1 *
    cos(5.0 * x);

  return dlerp(
    openSmile,
    circleMouth,
    -0.5,
    openSmile,
    uwumouth,
    u_joystick2.x,
    u_joystick2.y
  );
}

float mouthBot(float x) {
  if (cppUnqualifiedAbs(x) > 0.85) {
    return 5.0;
  }

  float closeSmile =
    0.7 *
    x * x * x * x -
    0.55;

  float openSmile =
    1.1 *
    x * x * x * x -
    0.75;

  float leftness =
    clamp(
      -u_joystick2.x,
      0.0,
      1.0
    );

  float cx =
    x *
    (
      1.0 -
      0.544355294118 *
      (1.0 - leftness)
    );

  float circleMouth =
    -sqrt(
      0.15 -
      cx * cx
    ) -
    0.35;

  float uwumouth =
    sqrt(
      x * x +
      0.1
    ) -
    1.08;

  return dlerp(
    openSmile,
    circleMouth,
    -0.5,
    closeSmile,
    uwumouth,
    u_joystick2.x,
    u_joystick2.y
  );
}

bool topTooth(
  vec2 point,
  float mouthTopValue
) {
  vec2 p = vec2(
    cppUnqualifiedAbs(point.x),
    point.y
  );

  float topLeftX = dlerp(
    0.395,
    0.25,
    0.395,
    0.395,
    0.39,
    u_joystick2.x,
    u_joystick2.y
  );

  float topLeftY = dlerp(
    -0.497,
    -0.018,
    -0.497,
    -0.497,
    -0.283,
    u_joystick2.x,
    u_joystick2.y
  );

  float topRightX = dlerp(
    0.602,
    0.373,
    0.602,
    0.602,
    0.55,
    u_joystick2.x,
    u_joystick2.y
  );

  float topRightY = dlerp(
    -0.420,
    -0.164,
    -0.420,
    -0.420,
    -0.3,
    u_joystick2.x,
    u_joystick2.y
  );

  float bottomX = dlerp(
    0.500,
    0.174,
    0.500,
    0.500,
    0.418,
    u_joystick2.x,
    u_joystick2.y
  );

  float bottomY = dlerp(
    -0.650,
    -0.251,
    -0.650,
    -0.650,
    -0.496,
    u_joystick2.x,
    u_joystick2.y
  );

  return
    inTri(
      p,
      vec2(topLeftX, topLeftY),
      vec2(topRightX, topRightY),
      vec2(bottomX, bottomY),
      0.1
    ) &&
    point.y <= mouthTopValue;
}

bool bottomTooth(
  vec2 point,
  float mouthBotValue,
  float mouthTopValue
) {
  vec2 p = vec2(
    cppUnqualifiedAbs(point.x),
    point.y
  );

  float botLeftX = dlerp(
    0.22,
    0.173,
    0.22,
    0.22,
    0.242,
    u_joystick2.x,
    u_joystick2.y
  );

  float botLeftY = dlerp(
    -0.81,
    -0.73,
    -0.81,
    -0.81,
    -0.716,
    u_joystick2.x,
    u_joystick2.y
  );

  float botRightX = dlerp(
    0.412,
    0.337,
    0.412,
    0.412,
    0.4,
    u_joystick2.x,
    u_joystick2.y
  );

  float botRightY = dlerp(
    -0.805,
    -0.6,
    -0.805,
    -0.805,
    -0.618,
    u_joystick2.x,
    u_joystick2.y
  );

  float topX = dlerp(
    0.318,
    0.172,
    0.318,
    0.318,
    0.255,
    u_joystick2.x,
    u_joystick2.y
  );

  float topY = dlerp(
    -0.6,
    -0.513,
    -0.6,
    -0.6,
    -0.473,
    u_joystick2.x,
    u_joystick2.y
  );

  return
    inTri(
      p,
      vec2(botLeftX, botLeftY),
      vec2(botRightX, botRightY),
      vec2(topX, topY),
      0.1
    ) &&
    point.y >= mouthBotValue &&
    point.y <= mouthTopValue;
}

bool tonguePredicate(
  vec2 point,
  float mouthTopValue
) {
  float top = min(
    mouthTopValue,
    dlerp(
      1.0,
      1.0,
      1.0,
      1.0,
      1.0,
      u_joystick2.x,
      u_joystick2.y
    )
  );

  float bottomdef =
    -0.1 *
    sqrt(
      0.04 -
      point.x * point.x
    ) -
    0.7;

  float bottom = dlerp(
    1.0,
    1.0,
    bottomdef,
    1.0,
    1.0,
    u_joystick2.x,
    u_joystick2.y
  );

  return
    point.y <= top &&
    point.y >= bottom;
}

bool topBangsPredicate(vec2 point) {
  point.x += 0.05;

  return inConvex5(
    point,
    vec2(-0.54, 1.54),
    vec2(-0.455, 0.74),
    vec2(-0.234, 0.366),
    vec2(0.42, 0.656),
    vec2(0.758, 1.55)
  );
}

bool bottomBangsPredicate(vec2 point) {
  point.x += 0.05;

  return
    inConvex5(
      point,
      vec2(-0.11, 0.575),
      vec2(-0.234, 0.37),
      vec2(-0.063, 0.162),
      vec2(0.238, 0.336),
      vec2(0.188, 0.63)
    ) ||
    inConvex5(
      point,
      vec2(-0.11, 0.575),
      vec2(-0.234, 0.37),
      vec2(0.412, 0.64),
      vec2(0.258, 0.657),
      vec2(0.046, 0.638)
    ) ||
    inConvex4(
      point,
      vec2(-0.063, 0.162),
      vec2(0.318, 0.132),
      vec2(0.456, 0.366),
      vec2(0.238, 0.336)
    ) ||
    inConvex4(
      point,
      vec2(0.456, 0.366),
      vec2(0.417, 0.513),
      vec2(0.373, 0.513),
      vec2(0.379, 0.32)
    ) ||
    inConvex3(
      point,
      vec2(0.373, 0.513),
      vec2(0.325, 0.455),
      vec2(0.41, 0.465)
    );
}

float applyAntialiasingCoverageFalloff(
  float coverage,
  float gridSize
) {
  coverage =
    clamp(
      coverage,
      0.0,
      1.0
    );

  if (
    gridSize < 2.0 ||
    ANTIALIASING_COVERAGE_FALLOFF <= 0.0
  ) {
    return coverage;
  }

  return pow(
    coverage,
    1.0 +
    ANTIALIASING_COVERAGE_FALLOFF
  );
}

vec3 shadeSample(vec2 center) {
  float blinkability = dlerp(
    1.0,
    0.0,
    1.0,
    0.0,
    0.0,
    u_joystick1.x,
    u_joystick1.y
  );

  float safeOffsetX =
    clamp(
      u_pupilGaze.x,
      -0.10,
      0.10
    );

  float leftAbsoluteX =
    EYE_SPACING -
    safeOffsetX;

  float rightAbsoluteX =
    EYE_SPACING +
    safeOffsetX;

  float safeLowerY =
    max(
      eyeLower(
        leftAbsoluteX,
        u_blink,
        blinkability
      ),
      eyeLower(
        rightAbsoluteX,
        u_blink,
        blinkability
      )
    ) -
    0.1 +
    PUPIL_VISIBLE_INSET;

  float safeUpperY =
    min(
      eyeUpper(
        leftAbsoluteX,
        u_blink,
        blinkability
      ),
      eyeUpper(
        rightAbsoluteX,
        u_blink,
        blinkability
      )
    ) -
    0.1 -
    PUPIL_VISIBLE_INSET;

  float contentaAmount =
    max(
      -u_joystick1.x,
      0.0
    );

  float sleepyAmount =
    max(
      -u_joystick1.y,
      0.0
    ) *
    (
      1.0 -
      abs(u_joystick1.x)
    );

  float hiddenEyeAmount =
    max(
      contentaAmount,
      sleepyAmount
    );

  float exitAmount =
    smoothstep01(
      (
        hiddenEyeAmount -
        0.80
      ) /
      0.20
    );

  float pupilOffsetX =
    hiddenEyeAmount > 0.0
      ? 0.0
      : safeOffsetX;

  float pupilOffsetY;

  if (hiddenEyeAmount > 0.0) {
    pupilOffsetY =
      0.15 +
      3.0 *
      exitAmount;
  } else if (safeLowerY <= safeUpperY) {
    pupilOffsetY =
      clamp(
        u_pupilGaze.y,
        safeLowerY,
        safeUpperY
      );
  } else {
    pupilOffsetY =
      0.5 *
      (
        safeLowerY +
        safeUpperY
      );
  }

  float leftCenterX =
    -EYE_SPACING +
    pupilOffsetX -
    0.03 *
    cppUnqualifiedAbs(
      pupilOffsetX
    );

  float rightCenterX =
    EYE_SPACING +
    pupilOffsetX +
    0.03 *
    cppUnqualifiedAbs(
      pupilOffsetX
    );

  float centerY =
    pupilOffsetY;

  float mouthTopValue =
    mouthTop(center.x);

  float mouthBotValue =
    mouthBot(center.x);

  float gridSize =
    RAST_GRID_SIZE;

  float sampleCount =
    gridSize *
    gridSize;

  vec2 pixelMin =
    center -
    u_pixelSize *
    0.5;

  vec2 browPixelMin =
    vec2(
      cppUnqualifiedAbs(center.x),
      center.y
    ) -
    u_pixelSize *
    0.5;

  float eyeHits = 0.0;
  float pupilHits = 0.0;
  float scleraHits = 0.0;
  float innerPupilHits = 0.0;
  float browHits = 0.0;
  float mouthHits = 0.0;
  float toothHits = 0.0;
  float tongueHits = 0.0;
  float topBangsHits = 0.0;
  float bottomBangsHits = 0.0;

  for (
    int sampleY = 0;
    sampleY < __RAST_LOOP_BOUND__;
    ++sampleY
  ) {
    for (
      int sampleX = 0;
      sampleX < __RAST_LOOP_BOUND__;
      ++sampleX
    ) {
      vec2 subpixel =
        (
          vec2(
            float(sampleX),
            float(sampleY)
          ) +
          vec2(0.5)
        ) /
        gridSize;

      vec2 point =
        pixelMin +
        subpixel *
        u_pixelSize;

      vec2 browPoint =
        browPixelMin +
        subpixel *
        u_pixelSize;

      bool inEye =
        eyePredicate(
          point,
          u_blink,
          blinkability
        );

      if (inEye) {
        eyeHits += 1.0;

        float leftDx =
          point.x -
          leftCenterX;

        float rightDx =
          point.x -
          rightCenterX;

        float dy =
          point.y -
          centerY;

        float leftDistanceSqr =
          leftDx *
          leftDx +
          dy *
          dy;

        float rightDistanceSqr =
          rightDx *
          rightDx +
          dy *
          dy;

        if (
          leftDistanceSqr <= PUPIL_RADIUS_SQR ||
          rightDistanceSqr <= PUPIL_RADIUS_SQR
        ) {
          pupilHits += 1.0;
        }

        if (
          leftDistanceSqr <= SCLERA_RADIUS_SQR ||
          rightDistanceSqr <= SCLERA_RADIUS_SQR
        ) {
          scleraHits += 1.0;
        }

        if (
          leftDistanceSqr <= INNER_PUPIL_RADIUS_SQR ||
          rightDistanceSqr <= INNER_PUPIL_RADIUS_SQR
        ) {
          innerPupilHits += 1.0;
        }
      }

      if (
        browPredicate(
          browPoint,
          u_blink,
          blinkability
        )
      ) {
        browHits += 1.0;
      }

      if (
        point.y > mouthBotValue &&
        point.y < mouthTopValue
      ) {
        mouthHits += 1.0;
      }

      if (
        topTooth(
          point,
          mouthTopValue
        ) ||
        bottomTooth(
          point,
          mouthBotValue,
          mouthTopValue
        )
      ) {
        toothHits += 1.0;
      }

      if (
        tonguePredicate(
          point,
          mouthTopValue
        )
      ) {
        tongueHits += 1.0;
      }

      if (topBangsPredicate(point)) {
        topBangsHits += 1.0;
      }

      if (bottomBangsPredicate(point)) {
        bottomBangsHits += 1.0;
      }
    }
  }

  float eyeCoverage =
    applyAntialiasingCoverageFalloff(
      eyeHits / sampleCount,
      gridSize
    );

  float pupilCoverage =
    applyAntialiasingCoverageFalloff(
      pupilHits / sampleCount,
      gridSize
    );

  float scleraCoverage =
    applyAntialiasingCoverageFalloff(
      scleraHits / sampleCount,
      gridSize
    );

  float innerPupilCoverage =
    applyAntialiasingCoverageFalloff(
      innerPupilHits / sampleCount,
      gridSize
    );

  float browCoverage =
    applyAntialiasingCoverageFalloff(
      browHits / sampleCount,
      gridSize
    );

  float mouthCoverage =
    applyAntialiasingCoverageFalloff(
      mouthHits / sampleCount,
      gridSize
    );

  float toothCoverage =
    applyAntialiasingCoverageFalloff(
      toothHits / sampleCount,
      gridSize
    );

  float tongueCoverage =
    applyAntialiasingCoverageFalloff(
      tongueHits / sampleCount,
      gridSize
    );

  float topBangsCoverage =
    applyAntialiasingCoverageFalloff(
      topBangsHits / sampleCount,
      gridSize
    );

  float bottomBangsCoverage =
    applyAntialiasingCoverageFalloff(
      bottomBangsHits / sampleCount,
      gridSize
    );

  vec3 color =
    BACKGROUND_COLOR;

  color = mix(
    color,
    EYE_COLOR,
    eyeCoverage
  );

  color = mix(
    color,
    PUPIL_COLOR,
    pupilCoverage
  );

  color = mix(
    color,
    SCLERA_COLOR,
    scleraCoverage
  );

  color = mix(
    color,
    INNER_PUPIL_COLOR,
    innerPupilCoverage
  );

  color = mix(
    color,
    BROW_COLOR,
    browCoverage
  );

  color = mix(
    color,
    MOUTH_COLOR,
    mouthCoverage
  );

  color = mix(
    color,
    TOOTH_COLOR,
    toothCoverage
  );

  color = mix(
    color,
    TONGUE_COLOR,
    tongueCoverage
  );

  color = mix(
    color,
    TOP_BANGS_COLOR,
    topBangsCoverage
  );

  color = mix(
    color,
    BOTTOM_BANGS_COLOR,
    bottomBangsCoverage
  );

  return color;
}

void main() {
  float pixelX =
    floor(
      gl_FragCoord.x -
      0.5
    );

  float pixelYFromBottom =
    floor(
      gl_FragCoord.y -
      0.5
    );

  float pixelY =
    u_matrixSize.y -
    1.0 -
    pixelYFromBottom;

  vec3 accumulated =
    vec3(0.0);

  for (
    int sampleY = 0;
    sampleY < 2;
    ++sampleY
  ) {
    for (
      int sampleX = 0;
      sampleX < 2;
      ++sampleX
    ) {
      float subpixelX =
        (
          float(sampleX) +
          0.5
        ) /
        2.0;

      float subpixelY =
        (
          float(sampleY) +
          0.5
        ) /
        2.0;

      vec2 worldPoint = vec2(
        -1.5 +
        (
          pixelX +
          subpixelX
        ) *
        u_pixelSize.x,

        0.75 -
        (
          pixelY +
          subpixelY
        ) *
        u_pixelSize.y
      );

      accumulated +=
        shadeSample(worldPoint);
    }
  }

  vec3 color =
    accumulated *
    0.25;

  // Match toRgb8(): clamp, multiply by 255, round to nearest integer.
  vec3 quantized =
    floor(
      clamp(
        color,
        0.0,
        1.0
      ) *
      255.0 +
      0.5
    ) /
    255.0;

  gl_FragColor =
    vec4(
      quantized,
      1.0
    );
}
`;

  const rasterFragmentShaderSource =
    rasterFragmentShaderTemplate
      .replace(
        '__RAST_GRID_SIZE__',
        `${ANTIALIASING_LEVEL}.0`,
      )
      .replaceAll(
        '__RAST_LOOP_BOUND__',
        String(ANTIALIASING_LEVEL),
      )
      .replace(
        '__CPP_INTEGER_ABS__',
        CPP_INTEGER_ABS_COMPATIBILITY
          ? 'true'
          : 'false',
      );

  const displayFragmentShaderSource = `
precision highp float;

varying vec2 v_uv;
uniform sampler2D u_texture;

void main() {
  gl_FragColor =
    texture2D(
      u_texture,
      v_uv
    );
}
`;

  function numberedSource(source) {
    return source
      .split('\n')
      .map(
        (line, index) =>
          `${String(index + 1).padStart(4, ' ')} | ${line}`,
      )
      .join('\n');
  }

  function compileShader(
    type,
    source,
    label
  ) {
    const shaderObject =
      gl.createShader(type);

    if (!shaderObject) {
      throw new Error(
        `Could not allocate ${label} shader.`,
      );
    }

    gl.shaderSource(
      shaderObject,
      source,
    );

    gl.compileShader(shaderObject);

    if (
      !gl.getShaderParameter(
        shaderObject,
        gl.COMPILE_STATUS,
      )
    ) {
      const log =
        gl.getShaderInfoLog(shaderObject) ||
        'Unknown shader error';

      gl.deleteShader(shaderObject);

      throw new Error(
        `${label} shader compilation failed:\n${log}\n${numberedSource(source)}`,
      );
    }

    return shaderObject;
  }

  function createProgram(
    vertexSource,
    fragmentSource,
    label
  ) {
    const vertexShader =
      compileShader(
        gl.VERTEX_SHADER,
        vertexSource,
        `${label} vertex`,
      );

    const fragmentShader =
      compileShader(
        gl.FRAGMENT_SHADER,
        fragmentSource,
        `${label} fragment`,
      );

    const linkedProgram =
      gl.createProgram();

    if (!linkedProgram) {
      throw new Error(
        `Could not allocate ${label} program.`,
      );
    }

    gl.attachShader(
      linkedProgram,
      vertexShader,
    );

    gl.attachShader(
      linkedProgram,
      fragmentShader,
    );

    gl.bindAttribLocation(
      linkedProgram,
      0,
      'a_position',
    );

    gl.linkProgram(linkedProgram);

    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (
      !gl.getProgramParameter(
        linkedProgram,
        gl.LINK_STATUS,
      )
    ) {
      const log =
        gl.getProgramInfoLog(linkedProgram) ||
        'Unknown link error';

      gl.deleteProgram(linkedProgram);

      throw new Error(
        `${label} program link failed:\n${log}`,
      );
    }

    return linkedProgram;
  }

  function requireUniform(
    programObject,
    name
  ) {
    const location =
      gl.getUniformLocation(
        programObject,
        name,
      );

    if (location === null) {
      throw new Error(
        `Required shader uniform ${name} was optimized out or not found.`,
      );
    }

    return location;
  }

  const rasterProgram =
    createProgram(
      fullscreenVertexShaderSource,
      rasterFragmentShaderSource,
      'raster',
    );

  const displayProgram =
    createProgram(
      fullscreenVertexShaderSource,
      displayFragmentShaderSource,
      'display',
    );

  const rasterUniforms = {
    matrixSize:
      requireUniform(
        rasterProgram,
        'u_matrixSize',
      ),

    pixelSize:
      requireUniform(
        rasterProgram,
        'u_pixelSize',
      ),

    joystick1:
      requireUniform(
        rasterProgram,
        'u_joystick1',
      ),

    joystick2:
      requireUniform(
        rasterProgram,
        'u_joystick2',
      ),

    pupilGaze:
      requireUniform(
        rasterProgram,
        'u_pupilGaze',
      ),

    blink:
      requireUniform(
        rasterProgram,
        'u_blink',
      ),
  };

  const displayTextureUniform =
    requireUniform(
      displayProgram,
      'u_texture',
    );

  const quadBuffer =
    gl.createBuffer();

  if (!quadBuffer) {
    throw new Error(
      'Could not create fullscreen quad buffer.',
    );
  }

  gl.bindBuffer(
    gl.ARRAY_BUFFER,
    quadBuffer,
  );

  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1,
    ]),
    gl.STATIC_DRAW,
  );

  function bindFullscreenQuad() {
    gl.bindBuffer(
      gl.ARRAY_BUFFER,
      quadBuffer,
    );

    gl.enableVertexAttribArray(0);

    gl.vertexAttribPointer(
      0,
      2,
      gl.FLOAT,
      false,
      0,
      0,
    );
  }

  const logicalTexture =
    gl.createTexture();

  if (!logicalTexture) {
    throw new Error(
      'Could not create logical framebuffer texture.',
    );
  }

  gl.bindTexture(
    gl.TEXTURE_2D,
    logicalTexture,
  );

  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_WRAP_S,
    gl.CLAMP_TO_EDGE,
  );

  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_WRAP_T,
    gl.CLAMP_TO_EDGE,
  );

  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.NEAREST,
  );

  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MAG_FILTER,
    gl.NEAREST,
  );

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    MATRIX_WIDTH,
    MATRIX_HEIGHT,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );

  const logicalFramebuffer =
    gl.createFramebuffer();

  if (!logicalFramebuffer) {
    throw new Error(
      'Could not create logical framebuffer.',
    );
  }

  gl.bindFramebuffer(
    gl.FRAMEBUFFER,
    logicalFramebuffer,
  );

  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    logicalTexture,
    0,
  );

  if (
    gl.checkFramebufferStatus(
      gl.FRAMEBUFFER,
    ) !== gl.FRAMEBUFFER_COMPLETE
  ) {
    throw new Error(
      'The 64x32 logical framebuffer is incomplete.',
    );
  }

  gl.bindFramebuffer(
    gl.FRAMEBUFFER,
    null,
  );

  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);

  gl.pixelStorei(
    gl.UNPACK_ALIGNMENT,
    1,
  );

  const f32 = Math.fround;

  function clamp(
    value,
    minimum,
    maximum
  ) {
    return Math.min(
      maximum,
      Math.max(
        minimum,
        value,
      ),
    );
  }

  function clampAxis(value) {
    return clamp(
      Number.isFinite(value)
        ? value
        : 0,
      -1,
      1,
    );
  }

  function lerpFloat(
    a,
    b,
    amount
  ) {
    return f32(
      f32(a) +
      f32(
        f32(b - a) *
        f32(amount),
      ),
    );
  }

  function smoothstep01(value) {
    const t =
      f32(
        clamp(
          value,
          0,
          1,
        ),
      );

    return f32(
      f32(t * t) *
      f32(
        3 -
        f32(2 * t),
      ),
    );
  }

  function easeOutCubic(value) {
    const t =
      f32(
        clamp(
          value,
          0,
          1,
        ),
      );

    const inverse =
      f32(1 - t);

    return f32(
      1 -
      f32(
        f32(inverse * inverse) *
        inverse,
      ),
    );
  }

  const animationState = {
    randomState:
      0xA341316C >>> 0,

    blinkTimerInitialized:
      false,

    nextBlinkStart:
      f32(0),

    activeBlinkStart:
      f32(-1000),

    previousTime:
      f32(0),

    pupilMotionInitialized:
      false,

    pupilWasBlinking:
      false,

    pupilPreviousTime:
      f32(0),

    pupilNextFixation:
      f32(0),

    pupilSaccadeStart:
      f32(0),

    pupilSaccadeEnd:
      f32(0),

    pupilStartX:
      f32(0),

    pupilStartY:
      f32(0.15),

    pupilTargetX:
      f32(0),

    pupilTargetY:
      f32(0.15),

    pupilGazeX:
      f32(0),

    pupilGazeY:
      f32(0.15),
  };

  function random01() {
    let value =
      animationState.randomState >>>
      0;

    value =
      (
        value ^
        (
          value << 13
        )
      ) >>>
      0;

    value =
      (
        value ^
        (
          value >>> 17
        )
      ) >>>
      0;

    value =
      (
        value ^
        (
          value << 5
        )
      ) >>>
      0;

    animationState.randomState =
      value;

    return f32(
      (
        value &
        0x00FFFFFF
      ) /
      0x01000000,
    );
  }

  function cheapNormalish() {
    let total =
      f32(
        random01() +
        random01(),
      );

    total =
      f32(
        total +
        random01(),
      );

    total =
      f32(
        total +
        random01(),
      );

    const average =
      f32(
        total *
        f32(0.25),
      );

    return f32(
      f32(
        average -
        f32(0.5),
      ) *
      f32(2),
    );
  }

  function chooseBlinkInterval() {
    const closeTime =
      f32(0.085);

    const closedTime =
      f32(0.045);

    const openTime =
      f32(0.145);

    const totalBlinkTime =
      f32(
        f32(
          closeTime +
          closedTime,
        ) +
        openTime,
      );

    const averageInterval =
      f32(4.20);

    const categoryRoll =
      random01();

    const variation =
      cheapNormalish();

    if (
      categoryRoll <
      f32(0.05)
    ) {
      return f32(
        Math.max(
          totalBlinkTime,
          f32(
            f32(0.25) +
            f32(
              variation *
              f32(0.07),
            ),
          ),
        ),
      );
    }

    if (
      categoryRoll <
      f32(0.20)
    ) {
      return f32(
        f32(
          averageInterval *
          f32(3),
        ) +
        f32(
          f32(
            variation +
            f32(1),
          ) *
          f32(
            averageInterval *
            f32(0.5),
          ),
        ),
      );
    }

    return f32(
      averageInterval +
      f32(
        variation *
        f32(1.05),
      ),
    );
  }

  function updatePersistentAnimation(
    timeSeconds
  ) {
    const time =
      f32(timeSeconds);

    const closeTime =
      f32(0.085);

    const closedTime =
      f32(0.045);

    const openTime =
      f32(0.145);

    const totalBlinkTime =
      f32(
        f32(
          closeTime +
          closedTime,
        ) +
        openTime,
      );

    if (
      !animationState.blinkTimerInitialized ||
      time < animationState.previousTime
    ) {
      animationState.blinkTimerInitialized =
        true;

      animationState.activeBlinkStart =
        f32(-1000);

      animationState.nextBlinkStart =
        f32(
          time +
          chooseBlinkInterval(),
        );
    }

    animationState.previousTime =
      time;

    if (
      time >=
      animationState.nextBlinkStart
    ) {
      animationState.activeBlinkStart =
        time;

      animationState.nextBlinkStart =
        f32(
          animationState.activeBlinkStart +
          chooseBlinkInterval(),
        );
    }

    const blinkTime =
      f32(
        time -
        animationState.activeBlinkStart,
      );

    let blink =
      f32(0);

    if (
      blinkTime >= 0 &&
      blinkTime < closeTime
    ) {
      blink =
        easeOutCubic(
          f32(
            blinkTime /
            closeTime,
          ),
        );
    } else if (
      blinkTime >= closeTime &&
      blinkTime <
      f32(
        closeTime +
        closedTime,
      )
    ) {
      blink =
        f32(1);
    } else if (
      blinkTime >=
      f32(
        closeTime +
        closedTime,
      ) &&
      blinkTime < totalBlinkTime
    ) {
      const openingTime =
        f32(
          blinkTime -
          closeTime -
          closedTime,
        );

      blink =
        f32(
          1 -
          smoothstep01(
            f32(
              openingTime /
              openTime,
            ),
          ),
        );
    }

    const newPupilFrame =
      !animationState.pupilMotionInitialized ||
      time !==
      animationState.pupilPreviousTime;

    if (
      !animationState.pupilMotionInitialized ||
      time <
      animationState.pupilPreviousTime
    ) {
      animationState.pupilMotionInitialized =
        true;

      animationState.pupilWasBlinking =
        false;

      animationState.pupilNextFixation =
        f32(
          time +
          f32(0.7),
        );

      animationState.pupilSaccadeStart =
        time;

      animationState.pupilSaccadeEnd =
        time;

      animationState.pupilStartX =
        f32(0);

      animationState.pupilTargetX =
        f32(0);

      animationState.pupilGazeX =
        f32(0);

      animationState.pupilStartY =
        f32(0.15);

      animationState.pupilTargetY =
        f32(0.15);

      animationState.pupilGazeY =
        f32(0.15);
    }

    if (newPupilFrame) {
      const blinking =
        blink >
        f32(0.10);

      const blinkStarted =
        blinking &&
        !animationState.pupilWasBlinking;

      if (
        time <
        animationState.pupilSaccadeEnd
      ) {
        const denominator =
          Math.max(
            f32(0.001),
            f32(
              animationState.pupilSaccadeEnd -
              animationState.pupilSaccadeStart,
            ),
          );

        const progress =
          smoothstep01(
            f32(
              f32(
                time -
                animationState.pupilSaccadeStart,
              ) /
              denominator,
            ),
          );

        animationState.pupilGazeX =
          lerpFloat(
            animationState.pupilStartX,
            animationState.pupilTargetX,
            progress,
          );

        animationState.pupilGazeY =
          lerpFloat(
            animationState.pupilStartY,
            animationState.pupilTargetY,
            progress,
          );
      } else {
        animationState.pupilGazeX =
          animationState.pupilTargetX;

        animationState.pupilGazeY =
          animationState.pupilTargetY;
      }

      const fixationExpired =
        time >=
        animationState.pupilNextFixation;

      const blinkRequestedReset =
        !fixationExpired &&
        blinkStarted &&
        random01() <
        f32(0.72);

      if (
        fixationExpired ||
        blinkRequestedReset
      ) {
        animationState.pupilStartX =
          animationState.pupilGazeX;

        animationState.pupilStartY =
          animationState.pupilGazeY;

        if (
          random01() <
          f32(0.78)
        ) {
          animationState.pupilTargetX =
            f32(
              cheapNormalish() *
              f32(0.075),
            );

          animationState.pupilTargetY =
            f32(
              f32(0.15) +
              f32(
                cheapNormalish() *
                f32(0.095),
              ),
            );
        } else {
          const angle =
            f32(
              random01() *
              f32(6.28318530718),
            );

          const reach =
            f32(
              f32(0.72) +
              f32(
                random01() *
                f32(0.28),
              ),
            );

          animationState.pupilTargetX =
            f32(
              f32(
                Math.cos(angle),
              ) *
              f32(
                f32(0.10) *
                reach,
              ),
            );

          animationState.pupilTargetY =
            f32(
              f32(0.15) +
              f32(
                f32(
                  Math.sin(angle),
                ) *
                f32(
                  f32(0.15) *
                  reach,
                ),
              ),
            );
        }

        animationState.pupilSaccadeStart =
          time;

        const deltaX =
          f32(
            animationState.pupilTargetX -
            animationState.pupilStartX,
          );

        const deltaY =
          f32(
            animationState.pupilTargetY -
            animationState.pupilStartY,
          );

        const distance =
          f32(
            Math.sqrt(
              f32(
                f32(
                  deltaX *
                  deltaX,
                ) +
                f32(
                  deltaY *
                  deltaY,
                ),
              ),
            ),
          );

        animationState.pupilSaccadeEnd =
          f32(
            time +
            f32(
              f32(0.028) +
              f32(
                distance *
                f32(0.22),
              ),
            ),
          );

        animationState.pupilNextFixation =
          f32(
            time +
            f32(
              f32(0.45) +
              f32(
                random01() *
                f32(1.9),
              ),
            ),
          );
      }

      animationState.pupilWasBlinking =
        blinking;

      animationState.pupilPreviousTime =
        time;
    }

    return {
      blink,
      pupilGazeX:
        animationState.pupilGazeX,
      pupilGazeY:
        animationState.pupilGazeY,
    };
  }

  function applyRadialDeadzone(
    x,
    y
  ) {
    const clampedX =
      clampAxis(x);

    const clampedY =
      clampAxis(y);

    const magnitude =
      Math.hypot(
        clampedX,
        clampedY,
      );

    if (
      magnitude <=
      CONTROLLER_DEADZONE
    ) {
      return {
        x: 0,
        y: 0,
      };
    }

    const safeMagnitude =
      Math.max(
        magnitude,
        0.00001,
      );

    const scaledMagnitude =
      clamp(
        (
          magnitude -
          CONTROLLER_DEADZONE
        ) /
        (
          1 -
          CONTROLLER_DEADZONE
        ),
        0,
        1,
      );

    return {
      x:
        clampAxis(
          (
            clampedX /
            safeMagnitude
          ) *
          scaledMagnitude,
        ),

      y:
        clampAxis(
          (
            clampedY /
            safeMagnitude
          ) *
          scaledMagnitude,
        ),
    };
  }

  const touchInput = {
    left: {
      x: 0,
      y: 0,
      active: false,
    },

    right: {
      x: 0,
      y: 0,
      active: false,
    },
  };

  function resetTouchStick(
    stick,
    knob
  ) {
    stick.x = 0;
    stick.y = 0;
    stick.active = false;

    if (knob) {
      knob.style.transform =
        'translate(0px, 0px)';
    }
  }

  function installVirtualJoystick(
    target,
    knob,
    stick
  ) {
    if (!target || !knob) {
      return;
    }

    let activePointerId =
      null;

    const update = (event) => {
      const rect =
        target.getBoundingClientRect();

      const centerX =
        rect.left +
        rect.width *
        0.5;

      const centerY =
        rect.top +
        rect.height *
        0.5;

      const radius =
        Math.max(
          1,
          Math.min(
            rect.width,
            rect.height,
          ) *
          0.32,
        );

      const dx =
        event.clientX -
        centerX;

      const dy =
        event.clientY -
        centerY;

      const magnitude =
        Math.hypot(
          dx,
          dy,
        );

      const scale =
        magnitude > radius
          ? radius / magnitude
          : 1;

      const pixelX =
        dx *
        scale;

      const pixelY =
        dy *
        scale;

      knob.style.transform =
        `translate(${pixelX}px, ${pixelY}px)`;

      stick.x =
        clampAxis(
          pixelX /
          radius,
        );

      stick.y =
        clampAxis(
          -pixelY /
          radius,
        );

      stick.active =
        true;
    };

    target.addEventListener(
      'pointerdown',
      (event) => {
        if (activePointerId !== null) {
          return;
        }

        event.preventDefault();

        activePointerId =
          event.pointerId;

        target.setPointerCapture?.(
          event.pointerId,
        );

        update(event);
      },
    );

    target.addEventListener(
      'pointermove',
      (event) => {
        if (
          event.pointerId !==
          activePointerId
        ) {
          return;
        }

        event.preventDefault();
        update(event);
      },
    );

    const release = (event) => {
      if (
        event.pointerId !==
        activePointerId
      ) {
        return;
      }

      event.preventDefault();

      target.releasePointerCapture?.(
        event.pointerId,
      );

      activePointerId =
        null;

      resetTouchStick(
        stick,
        knob,
      );
    };

    target.addEventListener(
      'pointerup',
      release,
    );

    target.addEventListener(
      'pointercancel',
      release,
    );

    target.addEventListener(
      'lostpointercapture',
      (event) => {
        if (
          event.pointerId ===
          activePointerId
        ) {
          activePointerId =
            null;

          resetTouchStick(
            stick,
            knob,
          );
        }
      },
    );
  }

  installVirtualJoystick(
    leftJoy,
    leftKnob,
    touchInput.left,
  );

  installVirtualJoystick(
    rightJoy,
    rightKnob,
    touchInput.right,
  );

  function readGamepadInput() {
    const pads =
      navigator.getGamepads?.() ||
      [];

    let pad =
      null;

    for (const candidate of pads) {
      if (candidate?.connected) {
        pad =
          candidate;

        break;
      }
    }

    if (!pad) {
      return {
        joystick1: {
          x: 0,
          y: 0,
        },

        joystick2: {
          x: 0,
          y: 0,
        },

        faceButtons: [
          false,
          false,
          false,
          false,
        ],
      };
    }

    const joystick1 =
      applyRadialDeadzone(
        pad.axes[0] ?? 0,
        -(pad.axes[1] ?? 0),
      );

    const joystick2 =
      applyRadialDeadzone(
        pad.axes[2] ?? 0,
        -(pad.axes[3] ?? 0),
      );

    return {
      joystick1,
      joystick2,

      faceButtons:
        [0, 1, 2, 3].map(
          (index) =>
            Boolean(
              pad.buttons[index]
                ?.pressed,
            ),
        ),
    };
  }

  function readInputs() {
    const gamepad =
      readGamepadInput();

    return {
      joystick1: {
        x:
          f32(
            clampAxis(
              gamepad.joystick1.x +
              touchInput.left.x,
            ),
          ),

        y:
          f32(
            clampAxis(
              gamepad.joystick1.y +
              touchInput.left.y,
            ),
          ),
      },

      joystick2: {
        x:
          f32(
            clampAxis(
              gamepad.joystick2.x +
              touchInput.right.x,
            ),
          ),

        y:
          f32(
            clampAxis(
              gamepad.joystick2.y +
              touchInput.right.y,
            ),
          ),
      },

      faceButtons:
        gamepad.faceButtons,

      antialiasingLevel:
        ANTIALIASING_LEVEL,
    };
  }

  function resizeCanvas() {
    if (
      canvas.width !== MATRIX_WIDTH ||
      canvas.height !== MATRIX_HEIGHT
    ) {
      canvas.width = MATRIX_WIDTH;
      canvas.height = MATRIX_HEIGHT;
    }
  }

  function renderLogicalFrame(
    input,
    animation
  ) {
    gl.bindFramebuffer(
      gl.FRAMEBUFFER,
      logicalFramebuffer,
    );

    gl.viewport(
      0,
      0,
      MATRIX_WIDTH,
      MATRIX_HEIGHT,
    );

    gl.useProgram(
      rasterProgram,
    );

    bindFullscreenQuad();

    gl.uniform2f(
      rasterUniforms.matrixSize,
      MATRIX_WIDTH,
      MATRIX_HEIGHT,
    );

    gl.uniform2f(
      rasterUniforms.pixelSize,
      PIXEL_WIDTH,
      PIXEL_HEIGHT,
    );

    gl.uniform2f(
      rasterUniforms.joystick1,
      input.joystick1.x,
      input.joystick1.y,
    );

    gl.uniform2f(
      rasterUniforms.joystick2,
      input.joystick2.x,
      input.joystick2.y,
    );

    gl.uniform2f(
      rasterUniforms.pupilGaze,
      animation.pupilGazeX,
      animation.pupilGazeY,
    );

    gl.uniform1f(
      rasterUniforms.blink,
      animation.blink,
    );

    gl.drawArrays(
      gl.TRIANGLES,
      0,
      6,
    );
  }

  function displayLogicalFrame() {
    gl.bindFramebuffer(
      gl.FRAMEBUFFER,
      null,
    );

    gl.viewport(
      0,
      0,
      canvas.width,
      canvas.height,
    );

    gl.clearColor(
      0,
      0,
      0,
      1,
    );

    gl.clear(
      gl.COLOR_BUFFER_BIT,
    );

    const targetAspect =
      MATRIX_WIDTH /
      MATRIX_HEIGHT;

    const canvasAspect =
      canvas.width /
      canvas.height;

    let viewportWidth =
      canvas.width;

    let viewportHeight =
      canvas.height;

    let viewportX =
      0;

    let viewportY =
      0;

    if (
      canvasAspect >
      targetAspect
    ) {
      viewportWidth =
        Math.max(
          1,
          Math.floor(
            canvas.height *
            targetAspect,
          ),
        );

      viewportX =
        Math.floor(
          (
            canvas.width -
            viewportWidth
          ) *
          0.5,
        );
    } else if (
      canvasAspect <
      targetAspect
    ) {
      viewportHeight =
        Math.max(
          1,
          Math.floor(
            canvas.width /
            targetAspect,
          ),
        );

      viewportY =
        Math.floor(
          (
            canvas.height -
            viewportHeight
          ) *
          0.5,
        );
    }

    gl.viewport(
      viewportX,
      viewportY,
      viewportWidth,
      viewportHeight,
    );

    gl.useProgram(
      displayProgram,
    );

    bindFullscreenQuad();

    gl.activeTexture(
      gl.TEXTURE0,
    );

    gl.bindTexture(
      gl.TEXTURE_2D,
      logicalTexture,
    );

    gl.uniform1i(
      displayTextureUniform,
      0,
    );

    gl.drawArrays(
      gl.TRIANGLES,
      0,
      6,
    );
  }

  let firstFrameTimestamp =
    null;

  function animate(
    timestampMilliseconds
  ) {
    if (
      firstFrameTimestamp ===
      null
    ) {
      firstFrameTimestamp =
        timestampMilliseconds;
    }

    resizeCanvas();

    const timeSeconds =
      f32(
        (
          timestampMilliseconds -
          firstFrameTimestamp
        ) *
        0.001,
      );

    const input =
      readInputs();

    const animation =
      updatePersistentAnimation(
        timeSeconds,
      );

    renderLogicalFrame(
      input,
      animation,
    );

    displayLogicalFrame();

    requestAnimationFrame(
      animate,
    );
  }

  if (recenterButton) {
    recenterButton.addEventListener(
      'click',
      () => {
        resetTouchStick(
          touchInput.left,
          leftKnob,
        );

        resetTouchStick(
          touchInput.right,
          rightKnob,
        );
      },
    );
  }

  let installPrompt =
    null;

  window.addEventListener(
    'beforeinstallprompt',
    (event) => {
      event.preventDefault();

      installPrompt =
        event;

      if (installButton) {
        installButton.hidden =
          false;
      }
    },
  );

  if (installButton) {
    installButton.addEventListener(
      'click',
      async () => {
        if (!installPrompt) {
          return;
        }

        installPrompt.prompt();

        await installPrompt.userChoice;

        installPrompt =
          null;

        installButton.hidden =
          true;
      },
    );
  }

  canvas.addEventListener(
    'webglcontextlost',
    (event) => {
      event.preventDefault();
    },
  );

  canvas.addEventListener(
    'webglcontextrestored',
    () => {
      window.location.reload();
    },
  );

  window.addEventListener(
    'resize',
    resizeCanvas,
  );

  if ('serviceWorker' in navigator) {
    window.addEventListener(
      'load',
      () => {
        navigator.serviceWorker
          .register('./sw.js')
          .catch((error) => {
            console.warn(
              'Service worker registration failed:',
              error,
            );
          });
      },
    );
  }

  resizeCanvas();
  requestAnimationFrame(animate);
})();
