import { Plane } from 'lucide-react'

export default function SkyLinkLogo({ dark = false }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${dark ? 'bg-white' : 'bg-[#00818A]'}`}>
        <Plane size={16} className={dark ? 'text-[#00818A]' : 'text-white'} strokeWidth={2} />
      </div>
      <span className={`font-manrope text-lg ${dark ? 'text-white' : ''}`} style={{ fontWeight: 700, color: dark ? undefined : '#FFFFFF' }}>
        BIAL Citizen Developer
      </span>
    </div>
  )
}