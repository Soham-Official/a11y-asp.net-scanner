import React from 'react';

// Missing alt text (1.1.1)
export const BadImage = () => <img src="photo.jpg" />;

// Missing label (3.3.2/4.1.2)
export const BadForm = () => <input type="text" />;

// Click without keyboard (2.1.1)
export const BadClickHandler = () => <div onClick={() => alert('hi')}>Click</div>;

// Missing anchor content (2.4.4)
export const BadAnchor = () => <a href="/home"></a>;
