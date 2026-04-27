import { Plane } from 'lucide-react'

export default function SkyLinkLogo({ dark = false }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${dark ? 'bg-white' : 'bg-primary'}`}>
        <Plane size={16} className={dark ? 'text-primary' : 'text-white'} strokeWidth={2} />
      </div>
      <span className={`font-manrope font-bold text-lg ${dark ? 'text-white' : 'text-tertiary'}`}>
        SkyLink Builder
      </span>
    </div>
  )
}
