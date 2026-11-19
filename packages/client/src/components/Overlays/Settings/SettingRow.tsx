import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RotateCcw } from 'lucide-react'

export function SettingRow({
  label,
  description,
  onReset,
  children,
}: {
  label: string
  description?: string
  /** 传入时显示重置按钮，点击触发回调 */
  onReset?: () => void
  children: React.ReactNode
}) {
  return (
    // 移动端纵向堆叠（标签在上、控件在下），桌面端恢复左右两栏。
    // 之前固定 flex-row 时，长描述会把整行撑到超出容器宽度，
    // 右侧控件被挤出屏幕（移动端设置面板内容被裁切的根因）。
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 space-y-0.5">
        <Label className="block text-sm font-medium break-words">{label}</Label>
        {description && <p className="text-xs break-words text-muted-foreground">{description}</p>}
      </div>
      <div className="flex max-w-full flex-wrap items-center gap-1.5 sm:shrink-0 sm:justify-end">
        {onReset && (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={onReset}
              >
                <RotateCcw className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>恢复默认</TooltipContent>
          </Tooltip>
        )}
        {children}
      </div>
    </div>
  )
}
