interface ThumbnailProps {
  thumbnail_url: string
  title: string
}

export function Thumbnail({ thumbnail_url, title }: ThumbnailProps) {
  return (
    <div
      style={{
        width:        150,
        height:       150,
        borderRadius: 8,
        overflow:     'hidden',
        flexShrink:   0,
      }}
    >
      <img
        src={thumbnail_url}
        alt={title}
        style={{
          width:      '100%',
          height:     '100%',
          objectFit:  'cover',
          display:    'block',
        }}
        loading="lazy"
      />
    </div>
  )
}
