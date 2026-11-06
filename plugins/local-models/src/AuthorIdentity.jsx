import React, { useEffect, useRef, useState } from 'react'
import { Avatar } from '@mantine/core'
import huggingFaceLogo from './assets/huggingface.svg'
import './identity.css'

export function HuggingFaceMark() {
  return <img className="huggingface-mark lm-identity-mark" src={huggingFaceLogo} alt="" width="22" height="22" data-brand="huggingface" />
}

export function AuthorAvatar({ owner, avatars }) {
  const element = useRef(null)
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = true
    let lease
    setUrl(''); setFailed(false)
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      lease = avatars.acquire(owner)
      void lease.value.then(value => { if (current) { setUrl(value); setFailed(!value) } })
    }, { rootMargin: '160px' })
    observer.observe(element.current)
    return () => { current = false; observer.disconnect(); lease?.release() }
  }, [owner, avatars])
  return <Avatar component="span" ref={element} className="author-avatar lm-identity-avatar" size={22} radius="xl" color="gray" variant="light" src={url && !failed ? url : null} alt="" imageProps={{ onError: () => setFailed(true) }} aria-hidden="true" data-author={owner} data-avatar-state={failed ? 'fallback' : url ? 'ready' : 'pending'}>{owner.slice(0, 1).toUpperCase()}</Avatar>
}
