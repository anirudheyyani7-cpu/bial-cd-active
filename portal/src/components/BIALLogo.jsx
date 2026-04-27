export default function BIALLogo({ size = 40, showText = true }) {
  return (
    <div className="flex items-center gap-2">
      <svg width={size} height={size} viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Teal swirl */}
        <path d="M60 15 C35 15, 15 35, 15 60 C15 72, 20 83, 28 91 C40 75, 55 55, 80 45 C95 38, 108 38, 115 45 C110 28, 88 15, 60 15Z" fill="#00818A" />
        {/* Red/coral swirl */}
        <path d="M28 91 C36 99, 47 105, 60 105 C72 105, 83 100, 91 92 C80 88, 65 80, 55 68 C48 60, 44 50, 47 42 C37 52, 30 70, 28 91Z" fill="#D9534F" />
        {/* Amber/gold swirl */}
        <path d="M91 92 C99 84, 105 72, 105 60 C105 48, 100 37, 92 29 C88 42, 82 58, 70 70 C60 80, 46 87, 35 85 C42 95, 52 103, 60 105 C72 105, 83 100, 91 92Z" fill="#D9A036" />
        {/* Centre highlight */}
        <path d="M55 68 C60 62, 70 55, 80 52 C75 48, 68 47, 62 50 C56 53, 52 60, 55 68Z" fill="#26B7C0" opacity="0.7" />
      </svg>
      {showText && (
        <div className="flex flex-col leading-none">
          <span className="font-manrope font-bold text-primary text-sm tracking-wide">Bengaluru</span>
          <span className="font-manrope font-light text-tertiary text-[10px] tracking-widest uppercase">International Airport</span>
        </div>
      )}
    </div>
  )
}
