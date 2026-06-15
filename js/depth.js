/**
 * Depth Estimation Engine
 * Handles ONNX model loading, image preprocessing, and depth estimation
 */

class DepthEngine {
  constructor() {
    this.session = null;
  }

  /**
   * Initialize ONNX model with fallback options
   */
  async initModel() {
    if (this.session) return this.session;

    const modelOptions = [
      { path: './model/depthanything-quant.onnx', name: 'Local depthanything-quant' },
      { path: 'model/depthanything-quant.onnx', name: 'Local depthanything-quant (relative)' },
      { path: './model/model_q4f16.onnx', name: 'Local q4f16' },
      { path: 'model/model_q4f16.onnx', name: 'Local q4f16 (relative)' },
      { path: 'https://cdn.glitch.me/0f5359e2-6022-421b-88f7-13e276d0fb33/depthanything-quant.onnx', name: 'CDN depthanything-quant' }
    ];

    let lastError = null;
    for (const option of modelOptions) {
      try {
        console.log(`Trying to load model: ${option.name} from ${option.path}`);
        const sessionOptions = {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        };
        this.session = await ort.InferenceSession.create(option.path, sessionOptions);
        console.log(`✓ Model loaded successfully: ${option.name}`);
        return this.session;
      } catch (err) {
        console.warn(`✗ Failed to load ${option.name}:`, err);
        lastError = err;
      }
    }

    throw lastError || new Error('Model file was not found.');
  }

  /**
   * Resize image to max 512px on long edge while maintaining aspect ratio
   */
  resizeImage(img) {
    const maxSize = 512;
    let width = img.width;
    let height = img.height;

    if (width > height) {
      if (width > maxSize) {
        height = Math.round(height * (maxSize / width));
        width = maxSize;
      }
    } else {
      if (height > maxSize) {
        width = Math.round(width * (maxSize / height));
        height = maxSize;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);

    return { canvas, width, height };
  }

  /**
   * Preprocess ImageData for ONNX model input
   * Converts RGBA -> RGB, normalizes 0-255 -> 0-1, reorders NHWC -> NCHW
   */
  preprocess(imageData, width, height) {
    const data = imageData.data;
    const floatArr = new Float32Array(width * height * 3);

    // Extract RGB and normalize
    let j = 0;
    for (let i = 0; i < data.length; i += 4) {
      floatArr[j++] = data[i] / 255;       // R
      floatArr[j++] = data[i + 1] / 255;   // G
      floatArr[j++] = data[i + 2] / 255;   // B
    }

    // Reorder from NHWC to NCHW format
    const floatArr2 = new Float32Array(width * height * 3);
    const imageSize = width * height;

    for (let i = 0; i < imageSize; i++) {
      floatArr2[i] = floatArr[i * 3];                      // R channel
      floatArr2[imageSize + i] = floatArr[i * 3 + 1];     // G channel
      floatArr2[imageSize * 2 + i] = floatArr[i * 3 + 2]; // B channel
    }

    return floatArr2;
  }

  /**
   * Postprocess ONNX output to ImageData
   * Returns both display ImageData and raw Float32Array
   */
  postprocess(tensor) {
    let height, width;
    const tensorData = new Float32Array(tensor.data.buffer);

    // Handle v1 format [1,1,H,W] or v2 format [1,H,W]
    if (tensor.dims.length === 4) {
      height = tensor.dims[2];
      width = tensor.dims[3];
    } else if (tensor.dims.length === 3) {
      height = tensor.dims[1];
      width = tensor.dims[2];
    } else {
      console.error('Unexpected tensor dimensions:', tensor.dims);
      return null;
    }

    const imageData = new ImageData(width, height);
    const data = imageData.data;

    // Find min and max depth values
    let maxDepth = -Infinity;
    let minDepth = Infinity;

    for (let i = 0; i < tensorData.length; i++) {
      const value = tensorData[i];
      if (value > maxDepth) maxDepth = value;
      if (value < minDepth) minDepth = value;
    }

    // Normalize to 0-255 for display
    for (let i = 0; i < tensorData.length; i++) {
      const value = tensorData[i];
      const normalized = ((value - minDepth) / (maxDepth - minDepth)) * 255;
      const depth = Math.round(normalized);

      data[i * 4] = depth;       // R
      data[i * 4 + 1] = depth;   // G
      data[i * 4 + 2] = depth;   // B
      data[i * 4 + 3] = 255;     // A
    }

    return {
      imageData: imageData,
      rawData: tensorData,    // Keep original Float32Array for high precision
      width: width,
      height: height,
      min: minDepth,
      max: maxDepth
    };
  }

  /**
   * Run depth estimation on an image source
   * @param {string} imageSrc - Data URL or image path
   * @returns {Promise<Object>} - Contains original and depth data
   */
  async estimate(imageSrc) {
    // Ensure model is loaded
    const session = await this.initModel();
    if (!session) {
      throw new Error('Model initialization failed.');
    }

    return new Promise((resolve, reject) => {
      const img = new Image();

      img.onload = async () => {
        try {
          // Resize image
          const { canvas, width, height } = this.resizeImage(img);
          const ctx = canvas.getContext('2d');
          const imageData = ctx.getImageData(0, 0, width, height);

          // Preprocess for ONNX
          const preprocessed = this.preprocess(imageData, width, height);
          const inputTensor = new ort.Tensor(preprocessed, [1, 3, height, width]);

          console.log('Running inference with input shape:', [1, 3, height, width]);

          // Run inference
          const results = await this.session.run({ image: inputTensor });
          const output = results.depth;

          console.log('Inference complete. Output shape:', output.dims);

          // Postprocess
          const depthResult = this.postprocess(output);
          if (!depthResult) {
            throw new Error('Failed to generate the depth image.');
          }

          // Return both original and depth data
          resolve({
            original: {
              imageData: imageData,
              width: width,
              height: height
            },
            depth: {
              imageData: depthResult.imageData,
              rawData: depthResult.rawData,
              width: depthResult.width,
              height: depthResult.height,
              min: depthResult.min,
              max: depthResult.max
            }
          });

        } catch (error) {
          reject(error);
        }
      };

      img.onerror = () => {
        reject(new Error('Failed to load the image.'));
      };

      img.src = imageSrc;
    });
  }

  /**
   * Release ONNX session to free memory
   */
  async dispose() {
    if (this.session) {
      try {
        await this.session.release();
        console.log('ONNX session released');
      } catch (e) {
        console.warn('Failed to release ONNX session:', e);
      }
      this.session = null;
    }
  }
}

// Export for use in other modules
window.DepthEngine = DepthEngine;
