/**
 * Depth Estimation Engine
 * Handles ONNX model loading, image preprocessing, and depth estimation.
 */

class DepthEngine {
  constructor() {
    this.session = null;
    this.modelInfo = null;
  }

  /**
   * Initialize ONNX model with fallback options.
   */
  async initModel() {
    if (this.session) return this.session;

    const modelOptions = [
      {
        path: './model/da3/model.onnx',
        name: 'Local Depth Anything V3 Small',
        externalData: [{ path: 'model.onnx_data', data: './model/da3/model.onnx_data' }],
        inputName: 'pixel_values',
        outputName: 'predicted_depth',
        tensorShape: 'bichw',
        normalization: 'imagenet',
        invertDepth: true,
        alignTo: 14,
        maxSize: 518
      },
      {
        path: 'model/da3/model.onnx',
        name: 'Local Depth Anything V3 Small (relative)',
        externalData: [{ path: 'model.onnx_data', data: 'model/da3/model.onnx_data' }],
        inputName: 'pixel_values',
        outputName: 'predicted_depth',
        tensorShape: 'bichw',
        normalization: 'imagenet',
        invertDepth: true,
        alignTo: 14,
        maxSize: 518
      },
      {
        path: './model/depthanything-quant.onnx',
        name: 'Local depthanything-quant',
        inputName: 'image',
        outputName: 'depth',
        tensorShape: 'bchw',
        normalization: 'unit',
        invertDepth: false,
        alignTo: 1,
        maxSize: 512
      },
      {
        path: 'model/depthanything-quant.onnx',
        name: 'Local depthanything-quant (relative)',
        inputName: 'image',
        outputName: 'depth',
        tensorShape: 'bchw',
        normalization: 'unit',
        invertDepth: false,
        alignTo: 1,
        maxSize: 512
      }
    ];

    let lastError = null;
    for (const option of modelOptions) {
      try {
        console.log(`Trying to load model: ${option.name} from ${option.path}`);
        const sessionOptions = {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
          externalData: option.externalData
        };
        this.session = await ort.InferenceSession.create(option.path, sessionOptions);
        this.modelInfo = option;
        console.log(`Model loaded successfully: ${option.name}`);
        return this.session;
      } catch (err) {
        console.warn(`Failed to load ${option.name}:`, err);
        lastError = err;
      }
    }

    throw lastError || new Error('Model file was not found.');
  }

  /**
   * Resize image to the active model's preferred size while maintaining aspect ratio.
   */
  resizeImage(img) {
    const modelInfo = this.modelInfo || {};
    const maxSize = modelInfo.maxSize || 512;
    const alignTo = modelInfo.alignTo || 1;
    let width = img.width;
    let height = img.height;

    if (width > height) {
      if (width > maxSize) {
        height = Math.round(height * (maxSize / width));
        width = maxSize;
      }
    } else if (height > maxSize) {
      width = Math.round(width * (maxSize / height));
      height = maxSize;
    }

    if (alignTo > 1) {
      width = Math.max(alignTo, Math.round(width / alignTo) * alignTo);
      height = Math.max(alignTo, Math.round(height / alignTo) * alignTo);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);

    return { canvas, width, height };
  }

  /**
   * Preprocess ImageData for ONNX model input.
   * Converts RGBA to RGB, normalizes, and reorders NHWC to CHW.
   */
  preprocess(imageData, width, height) {
    const data = imageData.data;
    const floatArr = new Float32Array(width * height * 3);
    const imageSize = width * height;
    const modelInfo = this.modelInfo || {};
    const useImageNet = modelInfo.normalization === 'imagenet';
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];

    for (let i = 0; i < imageSize; i++) {
      const src = i * 4;
      const r = data[src] / 255;
      const g = data[src + 1] / 255;
      const b = data[src + 2] / 255;

      floatArr[i] = useImageNet ? (r - mean[0]) / std[0] : r;
      floatArr[imageSize + i] = useImageNet ? (g - mean[1]) / std[1] : g;
      floatArr[imageSize * 2 + i] = useImageNet ? (b - mean[2]) / std[2] : b;
    }

    return floatArr;
  }

  createInputTensor(preprocessed, height, width) {
    const modelInfo = this.modelInfo || {};
    const dims = modelInfo.tensorShape === 'bichw'
      ? [1, 1, 3, height, width]
      : [1, 3, height, width];
    return new ort.Tensor('float32', preprocessed, dims);
  }

  /**
   * Postprocess ONNX output to ImageData.
   * Returns both display ImageData and raw Float32Array.
   */
  postprocess(tensor) {
    let height, width;
    const tensorData = tensor.data instanceof Float32Array
      ? tensor.data
      : new Float32Array(tensor.data.buffer);

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
    let maxDepth = -Infinity;
    let minDepth = Infinity;

    for (let i = 0; i < tensorData.length; i++) {
      const value = tensorData[i];
      if (value > maxDepth) maxDepth = value;
      if (value < minDepth) minDepth = value;
    }

    const range = Math.max(maxDepth - minDepth, 1e-6);
    const invertDepth = Boolean(this.modelInfo?.invertDepth);
    const heightData = new Float32Array(tensorData.length);
    for (let i = 0; i < tensorData.length; i++) {
      const normalized = (tensorData[i] - minDepth) / range;
      const value = invertDepth ? 1 - normalized : normalized;
      heightData[i] = value;
      const depth = Math.round(value * 255);

      data[i * 4] = depth;
      data[i * 4 + 1] = depth;
      data[i * 4 + 2] = depth;
      data[i * 4 + 3] = 255;
    }

    return {
      imageData,
      rawData: tensorData,
      heightData,
      width,
      height,
      min: minDepth,
      max: maxDepth
    };
  }

  /**
   * Run depth estimation on an image source.
   * @param {string} imageSrc - Data URL or image path.
   * @returns {Promise<Object>} Contains original and depth data.
   */
  async estimate(imageSrc) {
    const session = await this.initModel();
    if (!session) {
      throw new Error('Model initialization failed.');
    }

    return new Promise((resolve, reject) => {
      const img = new Image();

      img.onload = async () => {
        try {
          const { canvas, width, height } = this.resizeImage(img);
          const ctx = canvas.getContext('2d');
          const imageData = ctx.getImageData(0, 0, width, height);
          const preprocessed = this.preprocess(imageData, width, height);
          const inputTensor = this.createInputTensor(preprocessed, height, width);
          const modelInfo = this.modelInfo || {};
          const inputName = modelInfo.inputName || this.session.inputNames?.[0] || 'image';
          const outputName = modelInfo.outputName || this.session.outputNames?.[0] || 'depth';

          console.log('Running inference with input shape:', inputTensor.dims);

          const results = await this.session.run({ [inputName]: inputTensor });
          const output = results[outputName] || results[this.session.outputNames?.[0]];
          if (!output) {
            throw new Error(`Model output was not found: ${outputName}`);
          }

          console.log('Inference complete. Output shape:', output.dims);

          const depthResult = this.postprocess(output);
          if (!depthResult) {
            throw new Error('Failed to generate the depth image.');
          }

          resolve({
            original: {
              imageData,
              width,
              height
            },
            depth: {
              imageData: depthResult.imageData,
              rawData: depthResult.rawData,
              heightData: depthResult.heightData,
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
   * Release ONNX session to free memory.
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
      this.modelInfo = null;
    }
  }
}

window.DepthEngine = DepthEngine;
