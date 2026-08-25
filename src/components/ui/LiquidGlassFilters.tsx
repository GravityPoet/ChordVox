export function LiquidGlassFilters() {
  return (
    <svg
      aria-hidden="true"
      style={{
        position: "absolute",
        width: 0,
        height: 0,
        overflow: "hidden",
      }}
    >
      <defs>
        {/* Standard refraction with chromatic aberration */}
        <filter id="lg-refract" colorInterpolationFilters="sRGB">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.009"
            numOctaves={2}
            seed={42}
            result="noise"
          />
          <feGaussianBlur in="noise" stdDeviation={1.2} result="blurred" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="blurred"
            scale={40}
            xChannelSelector="R"
            yChannelSelector="G"
            result="displaced"
          />
          <feColorMatrix
            in="displaced"
            type="matrix"
            values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="r"
          />
          <feOffset in="r" dx={-1.5} dy={0} result="r-shift" />
          <feColorMatrix
            in="displaced"
            type="matrix"
            values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="g"
          />
          <feColorMatrix
            in="displaced"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
            result="b"
          />
          <feOffset in="b" dx={1.5} dy={0} result="b-shift" />
          <feMerge>
            <feMergeNode in="r-shift" />
            <feMergeNode in="g" />
            <feMergeNode in="b-shift" />
          </feMerge>
        </filter>

        {/* Hero refraction — stronger displacement + chromatic aberration */}
        <filter id="lg-refract-hero" colorInterpolationFilters="sRGB">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.01"
            numOctaves={2}
            seed={7}
            result="noise"
          />
          <feGaussianBlur in="noise" stdDeviation={1.4} result="blurred" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="blurred"
            scale={56}
            xChannelSelector="R"
            yChannelSelector="G"
            result="displaced"
          />
          <feColorMatrix
            in="displaced"
            type="matrix"
            values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="r"
          />
          <feOffset in="r" dx={-2} dy={0} result="r-shift" />
          <feColorMatrix
            in="displaced"
            type="matrix"
            values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="g"
          />
          <feColorMatrix
            in="displaced"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
            result="b"
          />
          <feOffset in="b" dx={2} dy={0} result="b-shift" />
          <feMerge>
            <feMergeNode in="r-shift" />
            <feMergeNode in="g" />
            <feMergeNode in="b-shift" />
          </feMerge>
        </filter>
      </defs>
    </svg>
  );
}
